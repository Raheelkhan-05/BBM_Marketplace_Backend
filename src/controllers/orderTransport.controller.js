// controllers/orderTransport.controller.js
//
// Post-payment, OPTIONAL transport agreement between buyer and seller for ONE order.
// Either side suggests; the other accepts / declines / counter-suggests; the suggester can withdraw.
//
// SAVED AGREEMENTS: when a transport is accepted, it is remembered for seller + buyer + route
// (origin city/state -> destination city/state) in transport_agreements. On the NEXT order for the same
// seller + buyer + route, that agreed transport is applied automatically (no choosing, no approving).
// Either side can still change it for one order; accepting the change becomes the new saved agreement.
//
// Accepting writes the agreed transport onto the order (orders.transport_mode / transport_fields /
// transport_route_option_id), which the ship sheet and TransportInfoCard already read.
//
// The buyer (and the seller) can only choose what the SELLER services:
//   - the seller's approved saved routes for this exact origin -> destination city, and
//   - the modes in seller_profiles.transport_options.
//
// Notifications: every change notifies the other party (in-app + socket, plus a WhatsApp message when a new
// suggestion arrives). Types start with "order_" and link to the order page so the existing per-order unread
// badges pick them up.
import { supabase } from "../config/supabase.js";
import { notifyUser, notifyOrderChanged, notifyUserOrdersChanged } from "../services/realtimeBroadcast.js";
import { sendOrderUpdateWhatsApp } from "../services/whatsapp.service.js";
import { ROUTE_TRANSPORT_FIELDS, ROUTE_TRANSPORT_MODE_LABELS, routeOptionSummary } from "../../shared/routeTransportFields.js";

// Transport can be discussed from "paid & waiting for the seller" until the seller ships.
const NEGOTIABLE = ["pending_confirmation", "confirmed"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQ_COLS = "id, order_id, proposed_by_role, route_option_id, mode, fields, note, status, decline_reason, resolved_by_role, created_at, resolved_at";

const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const clip = (s, n) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ").slice(0, n) : "");

function wrap(fn) {
    return async (req, res) => {
        try { await fn(req, res); }
        catch (e) {
            console.error("[orderTransport]", e?.message || e);
            res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
        }
    };
}

// Loads the order + seller and works out who the caller is. Returns { fail: [status, message] } if not allowed.
async function loadContext(orderId, userId) {
    if (!UUID_RE.test(String(orderId || ""))) return { fail: [404, "Order not found."] };

    const { data: order, error } = await supabase
        .from("orders")
        .select("id, order_number, status, buyer_id, seller_id, shipping_address_snapshot, transport_mode, transport_fields, transport_route_option_id, transport_agreement_id, seller_response_due_at")
        .eq("id", orderId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!order) return { fail: [404, "Order not found."] };

    const { data: seller, error: sErr } = await supabase
        .from("seller_profiles")
        .select("id, user_id, display_name, city, state, dispatch_same_as_registered, dispatch_district, dispatch_state, transport_options")
        .eq("id", order.seller_id).maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!seller) return { fail: [404, "Order not found."] };

    const role = order.buyer_id === userId ? "buyer" : seller.user_id === userId ? "seller" : null;
    if (!role) return { fail: [404, "Order not found."] };

    const away = seller.dispatch_same_as_registered === false;
    const addr = order.shipping_address_snapshot || {};
    const route = {
        originCity: (away ? seller.dispatch_district : seller.city) || "",
        originState: (away ? seller.dispatch_state : seller.state) || "",
        destCity: addr.city || "",
        destState: addr.state || "",
    };
    return { order, seller, role, route };
}

const phaseOf = (order) => (order.transport_mode ? "agreed" : NEGOTIABLE.includes(order.status) ? "open" : "closed");
const isNegotiable = (order) => NEGOTIABLE.includes(order.status);

// ---- saved agreements (seller + buyer + route) -------------------------------------------------------
// Key parts are stored normalised (trimmed, single-spaced, lower-case) so "Rajkot " and "rajkot" are the same route.
const agreementKey = (order, seller, route) => {
    const k = {
        seller_id: order.seller_id, buyer_id: order.buyer_id,
        origin_city: norm(route.originCity), origin_state: norm(route.originState),
        dest_city: norm(route.destCity), dest_state: norm(route.destState),
    };
    // Without a real origin and destination city there is no route to remember.
    return k.origin_city && k.dest_city ? k : null;
};

async function findAgreement(key) {
    if (!key) return null;
    const { data, error } = await supabase.from("transport_agreements").select("*")
        .match({ ...key, status: "active" }).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
}

// Remember (or replace) the agreed transport for this seller + buyer + route.
async function saveAgreement(ctx, req) {
    const { order, seller, route } = ctx;
    const key = agreementKey(order, seller, route);
    if (!key) return null;
    const now = new Date().toISOString();
    const values = {
        mode: req.mode, fields: req.fields || {}, route_option_id: req.route_option_id || null,
        source_order_id: order.id, agreed_at: now, updated_at: now,
    };
    const existing = await findAgreement(key);
    if (existing) {
        const { data, error } = await supabase.from("transport_agreements").update(values).eq("id", existing.id).select("id").maybeSingle();
        if (error) throw new Error(error.message);
        return data?.id || existing.id;
    }
    const { data, error } = await supabase.from("transport_agreements").insert({ ...key, ...values, status: "active" }).select("id").maybeSingle();
    if (error) {
        if (error.code === "23505") return (await findAgreement(key))?.id || null; // created at the same moment by the other side
        throw new Error(error.message);
    }
    return data?.id || null;
}

// Is the remembered transport still something the seller offers? (They may have removed the route or the mode since.)
function agreementStillValid(agreement, options) {
    if (agreement.route_option_id) return options.routeOptions.some((r) => r.id === agreement.route_option_id);
    return options.modes.includes(agreement.mode);
}

// If this seller + buyer + route already has an agreed transport, apply it to the order (once, atomically).
// Safe to call any number of times and from anywhere (e.g. right after payment succeeds): it only acts on an
// order that is paid, not yet shipped and has no transport yet. Returns the updated order fields, or null.
export async function applySavedTransportAgreement(ctx) {
    const { order, seller, route } = ctx;
    if (order.transport_mode || !isNegotiable(order)) return null;
    const key = agreementKey(order, seller, route);
    const agreement = await findAgreement(key);
    if (!agreement) return null;

    const options = await buildOptions(seller, route);
    if (!agreementStillValid(agreement, options)) {
        // The seller no longer offers it: retire it so the normal "choose transport" flow takes over.
        await supabase.from("transport_agreements").update({ status: "ended", updated_at: new Date().toISOString() }).eq("id", agreement.id);
        return null;
    }

    const now = new Date().toISOString();
    const patch = {
        transport_mode: agreement.mode, transport_fields: agreement.fields || {},
        transport_route_option_id: agreement.route_option_id || null,
        transport_agreement_id: agreement.id, transport_confirmed_at: now,
    };
    const { data: upd, error } = await supabase.from("orders").update(patch)
        .eq("id", order.id).is("transport_mode", null).in("status", NEGOTIABLE).select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!upd) return null; // someone else set transport first; nothing to do

    // Tell the seller (the buyer is the one looking at the screen); also refresh both order screens.
    try {
        const label = routeOptionSummary(agreement.mode, agreement.fields || {});
        if (seller.user_id) {
            await notifyUser(seller.user_id, {
                type: "order_transport_auto_applied",
                title: `Transport already agreed for order ${order.order_number}`,
                body: `Same route as before, so the agreed transport was applied: ${label}.`,
                link: `/sell/orders/${order.id}`,
            });
        }
        await notifyOrderChanged(order.id, { transport: "updated" });
        await notifyUserOrdersChanged(order.buyer_id);
        if (seller.user_id) await notifyUserOrdersChanged(seller.user_id);
    } catch (e) {
        console.error("[orderTransport] auto-apply notify failed:", e?.message || e);
    }
    return { ...patch };
}

async function buildOptions(seller, route) {
    const modes = (Array.isArray(seller.transport_options) ? seller.transport_options : [])
        .filter((m) => ROUTE_TRANSPORT_FIELDS[m]);

    const { data, error } = await supabase
        .from("transport_route_options")
        .select("id, mode, fields, origin_city, dest_city")
        .eq("seller_id", seller.id).eq("status", "approved");
    if (error) throw new Error(error.message);

    const routeOptions = (data || [])
        .filter((r) => norm(r.origin_city) === norm(route.originCity) && norm(r.dest_city) === norm(route.destCity))
        .map((r) => ({ id: r.id, mode: r.mode, fields: r.fields || {}, summary: routeOptionSummary(r.mode, r.fields || {}) }));

    return { modes, routeOptions };
}

// Tells the OTHER party: in-app notification + live refresh of their order screens (+ optional WhatsApp).
async function notifyOther(ctx, actorRole, { type, title, body, whatsapp = null }) {
    try {
        const { order, seller } = ctx;
        const toUserId = actorRole === "buyer" ? seller.user_id : order.buyer_id;
        const link = actorRole === "buyer" ? `/sell/orders/${order.id}` : `/buy/orders/${order.id}`;
        if (toUserId) await notifyUser(toUserId, { type, title, body, link });
        await notifyOrderChanged(order.id, { transport: "updated" });
        await notifyUserOrdersChanged(order.buyer_id);
        if (seller.user_id) await notifyUserOrdersChanged(seller.user_id);

        if (whatsapp && toUserId) {
            const { data: p } = await supabase.from("profiles").select("name, phone").eq("id", toUserId).maybeSingle();
            if (p?.phone) {
                void sendOrderUpdateWhatsApp({
                    to: p.phone, name: p.name,
                    headline: whatsapp.headline, detail: whatsapp.detail,
                    footer: "Open the order in the app to respond.",
                }).catch((e) => console.error("[orderTransport] whatsapp failed:", e?.message || e));
            }
        }
    } catch (e) {
        console.error("[orderTransport] notify failed:", e?.message || e);
    }
}

// GET /api/order-transport/summary?as=buyer|seller
// One light call for the order LIST pages: which of my orders have a live transport conversation.
//   needs_you -> the other side suggested something and is waiting for me
//   waiting   -> I suggested something and am waiting for them
//   declined  -> the other side declined my suggestion
export const summaryOrderTransport = wrap(async (req, res) => {
    const as = req.query.as === "seller" ? "seller" : "buyer";
    let col, id;
    if (as === "buyer") { col = "buyer_id"; id = req.user.id; }
    else {
        const { data: s } = await supabase.from("seller_profiles").select("id").eq("user_id", req.user.id).maybeSingle();
        if (!s) return res.json({ success: true, summary: {} });
        col = "seller_id"; id = s.id;
    }

    const { data, error } = await supabase
        .from("order_transport_requests")
        .select("order_id, proposed_by_role, mode, fields, status, created_at, order:orders ( status, transport_mode )")
        .eq(col, id).in("status", ["proposed", "declined"])
        .order("created_at", { ascending: false }).limit(300);
    if (error) return res.status(500).json({ success: false, message: "Couldn't load transport updates." });

    const seen = new Set();
    const summary = {};
    for (const r of data || []) {
        if (seen.has(r.order_id)) continue; // newest row per order decides
        seen.add(r.order_id);
        const o = Array.isArray(r.order) ? r.order[0] : r.order;
        if (!o || !NEGOTIABLE.includes(o.status)) continue;

        const base = { mode: r.mode, fields: r.fields || {}, summary: routeOptionSummary(r.mode, r.fields || {}) };
        if (r.status === "proposed") {
            summary[r.order_id] = { ...base, state: r.proposed_by_role === as ? "waiting" : "needs_you" };
        } else if (r.status === "declined" && r.proposed_by_role === as && !o.transport_mode) {
            summary[r.order_id] = { ...base, state: "declined" };
        }
    }
    res.json({ success: true, summary });
});

// GET /api/order-transport/:orderId
export const getOrderTransport = wrap(async (req, res) => {
    const ctx = await loadContext(req.params.orderId, req.user.id);
    if (ctx.fail) return res.status(ctx.fail[0]).json({ success: false, message: ctx.fail[1] });
    const { order, seller, role, route } = ctx;

    // Same seller + buyer + route as an earlier agreement? Apply it now, so nobody has to choose or approve again.
    if (!order.transport_mode && isNegotiable(order)) {
        const applied = await applySavedTransportAgreement(ctx).catch((e) => { console.error("[orderTransport] auto-apply failed:", e?.message || e); return null; });
        if (applied) Object.assign(order, applied);
    }
    const phase = phaseOf(order);
    const canChange = phase === "agreed" && isNegotiable(order);

    let agreement = null;
    if (order.transport_agreement_id) {
        const { data: ag } = await supabase.from("transport_agreements").select("id, agreed_at").eq("id", order.transport_agreement_id).maybeSingle();
        agreement = ag || null;
    }

    const { data: rows, error } = await supabase
        .from("order_transport_requests").select(REQ_COLS)
        .eq("order_id", order.id).order("created_at", { ascending: false }).limit(20);
    if (error) return res.status(500).json({ success: false, message: "Couldn't load transport details." });

    const history = rows || [];
    const active = history.find((r) => r.status === "proposed") || null;
    const lastDeclined = !active ? (history.find((r) => r.status === "declined") || null) : null;

    res.json({
        success: true,
        role, phase,
        orderStatus: order.status,
        orderNumber: order.order_number,
        sellerName: seller.display_name,
        responseDueAt: order.status === "pending_confirmation" ? order.seller_response_due_at : null,
        canChange,
        agreedVia: order.transport_mode ? (order.transport_agreement_id ? "saved" : "order") : null,
        agreementAt: agreement?.agreed_at || null,
        route,
        agreed: order.transport_mode
            ? {
                mode: order.transport_mode, fields: order.transport_fields || {},
                summary: routeOptionSummary(order.transport_mode, order.transport_fields || {}),
                modeLabel: ROUTE_TRANSPORT_MODE_LABELS[order.transport_mode] || order.transport_mode,
            }
            : null,
        active, lastDeclined, history,
        options: phase === "open" || canChange ? await buildOptions(seller, route) : null,
    });
});

// POST /api/order-transport/:orderId/propose   { routeOptionId? | mode, fields?, note? }
export const proposeOrderTransport = wrap(async (req, res) => {
    const ctx = await loadContext(req.params.orderId, req.user.id);
    if (ctx.fail) return res.status(ctx.fail[0]).json({ success: false, message: ctx.fail[1] });
    const { order, seller, role, route } = ctx;
    if (!isNegotiable(order)) {
        return res.status(400).json({ success: false, message: "Transport can no longer be changed for this order." });
    }

    const { routeOptionId, mode: rawMode, fields, note } = req.body || {};
    const options = await buildOptions(seller, route);

    let mode, cleanFields = {}, routeId = null;
    if (routeOptionId) {
        const r = options.routeOptions.find((o) => o.id === routeOptionId);
        if (!r) return res.status(400).json({ success: false, message: "That route isn't available for this order." });
        mode = r.mode; cleanFields = r.fields; routeId = r.id;
    } else {
        mode = String(rawMode || "");
        if (!options.modes.includes(mode)) {
            return res.status(400).json({ success: false, message: "This seller doesn't offer that transport method." });
        }
        for (const f of ROUTE_TRANSPORT_FIELDS[mode]) {
            const v = clip(fields?.[f.key], 200);
            if (v) cleanFields[f.key] = v;
        }
    }

    // A new suggestion replaces whatever was still open (a counter-offer or an edit).
    await supabase.from("order_transport_requests")
        .update({ status: "superseded", resolved_at: new Date().toISOString() })
        .eq("order_id", order.id).eq("status", "proposed");

    const { data: created, error } = await supabase
        .from("order_transport_requests")
        .insert({
            order_id: order.id, buyer_id: order.buyer_id, seller_id: order.seller_id,
            proposed_by_role: role, route_option_id: routeId, mode, fields: cleanFields,
            note: clip(note, 300) || null, status: "proposed",
        })
        .select(REQ_COLS).single();
    if (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "This order's transport was just updated. Please review and try again." });
        console.error("[orderTransport] insert failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't send your suggestion." });
    }

    const label = routeOptionSummary(mode, cleanFields);
    const who = role === "buyer" ? "The buyer" : "The seller";
    await notifyOther(ctx, role, {
        type: "order_transport_requested",
        title: `Transport suggested for order ${order.order_number}`,
        body: `${who} suggested ${label} for delivery. Please accept or suggest another option.`,
        whatsapp: {
            headline: `${who} suggested a transport option for order #${order.order_number}.`,
            detail: `Suggested: ${label}. Please accept it or suggest another option.`,
        },
    });
    res.json({ success: true, request: created });
});

async function loadRequestAndContext(req, res) {
    const { data: r, error } = await supabase.from("order_transport_requests").select(REQ_COLS).eq("id", req.params.requestId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!r) { res.status(404).json({ success: false, message: "Request not found." }); return null; }
    const ctx = await loadContext(r.order_id, req.user.id);
    if (ctx.fail) { res.status(ctx.fail[0]).json({ success: false, message: ctx.fail[1] }); return null; }
    if (r.status !== "proposed") {
        res.status(400).json({ success: false, message: "This suggestion was already resolved. Please refresh." });
        return null;
    }
    return { r, ctx };
}

// POST /api/order-transport/requests/:requestId/accept   (the OTHER party only)
export const acceptOrderTransport = wrap(async (req, res) => {
    const loaded = await loadRequestAndContext(req, res);
    if (!loaded) return;
    const { r, ctx } = loaded;
    const { order, role } = ctx;
    if (r.proposed_by_role === role) return res.status(403).json({ success: false, message: "The other side needs to accept your suggestion." });
    if (!isNegotiable(order)) return res.status(400).json({ success: false, message: "Transport can no longer be changed for this order." });

    const now = new Date().toISOString();
    const { data: won } = await supabase.from("order_transport_requests")
        .update({ status: "accepted", resolved_at: now, resolved_by_role: role })
        .eq("id", r.id).eq("status", "proposed").select("id").maybeSingle();
    if (!won) return res.status(409).json({ success: false, message: "This suggestion was just changed. Please refresh." });

    const { data: upd, error } = await supabase.from("orders")
        .update({
            transport_mode: r.mode, transport_fields: r.fields || {},
            transport_route_option_id: r.route_option_id || null, transport_confirmed_at: now,
            transport_agreement_id: null, // set again below once the new agreement is saved
        })
        .eq("id", order.id).in("status", NEGOTIABLE)
        .select("id").maybeSingle();
    if (error || !upd) {
        await supabase.from("order_transport_requests")
            .update({ status: "proposed", resolved_at: null, resolved_by_role: null })
            .eq("id", r.id).eq("status", "accepted");
        return res.status(error ? 500 : 409).json({ success: false, message: "Couldn't save the agreed transport. Please try again." });
    }

    // Remember it for this seller + buyer + route, so the next order on this route needs no suggesting or approving.
    try {
        const agreementId = await saveAgreement(ctx, r);
        if (agreementId) await supabase.from("orders").update({ transport_agreement_id: agreementId }).eq("id", order.id);
    } catch (e) {
        console.error("[orderTransport] save agreement failed:", e?.message || e); // the order itself is already agreed
    }

    await notifyOther(ctx, role, {
        type: "order_transport_accepted",
        title: `Transport agreed for order ${order.order_number}`,
        body: `${role === "buyer" ? "The buyer" : "The seller"} accepted: ${routeOptionSummary(r.mode, r.fields || {})}. This will be used automatically for future orders on this route.`,
    });
    res.json({ success: true });
});

// POST /api/order-transport/requests/:requestId/decline   { reason? }   (the OTHER party only)
export const declineOrderTransport = wrap(async (req, res) => {
    const loaded = await loadRequestAndContext(req, res);
    if (!loaded) return;
    const { r, ctx } = loaded;
    const { order, role } = ctx;
    if (r.proposed_by_role === role) return res.status(403).json({ success: false, message: "You can withdraw your own suggestion instead." });

    const reason = clip(req.body?.reason, 300);
    const { data: done } = await supabase.from("order_transport_requests")
        .update({ status: "declined", decline_reason: reason || null, resolved_at: new Date().toISOString(), resolved_by_role: role })
        .eq("id", r.id).eq("status", "proposed").select("id").maybeSingle();
    if (!done) return res.status(409).json({ success: false, message: "This suggestion was just changed. Please refresh." });

    await notifyOther(ctx, role, {
        type: "order_transport_declined",
        title: `Transport suggestion declined (order ${order.order_number})`,
        body: reason || `${role === "buyer" ? "The buyer" : "The seller"} couldn't accept the suggested transport. You can suggest another option.`,
    });
    res.json({ success: true });
});

// POST /api/order-transport/requests/:requestId/withdraw   (the proposer only)
export const withdrawOrderTransport = wrap(async (req, res) => {
    const loaded = await loadRequestAndContext(req, res);
    if (!loaded) return;
    const { r, ctx } = loaded;
    const { order, role } = ctx;
    if (r.proposed_by_role !== role) return res.status(403).json({ success: false, message: "Only the person who suggested it can withdraw it." });

    const { data: done } = await supabase.from("order_transport_requests")
        .update({ status: "withdrawn", resolved_at: new Date().toISOString(), resolved_by_role: role })
        .eq("id", r.id).eq("status", "proposed").select("id").maybeSingle();
    if (!done) return res.status(409).json({ success: false, message: "This suggestion was just changed. Please refresh." });

    await notifyOther(ctx, role, {
        type: "order_transport_withdrawn",
        title: `Transport suggestion withdrawn (order ${order.order_number})`,
        body: "The previous transport suggestion was withdrawn.",
    });
    res.json({ success: true });
});