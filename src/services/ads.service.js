// services/ads.service.js — every money/slot decision happens in SQL (ad_book_slot / ad_admin_remove).
import { supabase } from "../config/supabase.js";
import { getIO } from "../socket/io.js";
import { notifyUser } from "./realtimeBroadcast.js";
import { notifyIfWalletJustBlocked } from "./walletNotifications.service.js";
import { publicUrl } from "./bannerImages.service.js";

export class AdError extends Error {
    constructor(status, message, code, details = null) {
        super(message); this.name = "AdError"; this.status = status; this.code = code || "AD_ERROR"; this.details = details;
    }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IST_OFFSET_MS = 19800000;
const inr = (n) => `₹${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const when = (d) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

const RPC_ERRORS = {
    PLACEMENT_UNAVAILABLE: [404, "This placement isn't available right now."],
    INVALID_DURATION: [400, "That duration isn't allowed for this placement."],
    INVALID_START: [400, "Bookings must start on the hour."],
    OUT_OF_WINDOW: [400, "That start time is in the past or too far ahead."],
    BLACKED_OUT: [409, "That time is closed for new bookings."],
    SLOT_TAKEN: [409, "Someone just booked that slot. Please pick another time."],
    INVALID_CREATIVE: [400, "Your banner or product selection isn't valid."],
    REASON_REQUIRED: [400, "Please give a reason (at least 5 characters)."],
    INVALID_REFUND_MODE: [400, "Invalid refund option."],
    BOOKING_NOT_FOUND: [404, "Booking not found."],
    ALREADY_REMOVED: [409, "This booking was already removed."],
    LANES_IN_USE: [409, "Active or upcoming bookings use the lanes you are removing."],
};

function rpcFail(error, label) {
    const msg = String(error?.message || "").trim();
    const [code, arg] = msg.split(":");
    if (code === "INSUFFICIENT_CREDITS") {
        const shortfall = Math.ceil(Number(arg) || 0);
        throw new AdError(402, `You need ${inr(shortfall)} more credits to book this.`, code, { shortfall });
    }
    if (code === "PRICE_CHANGED") {
        throw new AdError(409, "The price changed while you were booking. Please review the new price.", code, { currentTotal: Number(arg) });
    }
    if (error?.code === "23P01") throw new AdError(409, RPC_ERRORS.SLOT_TAKEN[1], "SLOT_TAKEN");
    const m = RPC_ERRORS[code];
    if (m) throw new AdError(m[0], m[1], code);
    console.error(`[ads] ${label} failed:`, error?.message || error);
    throw new AdError(500, "Something went wrong. Please try again.", "AD_ERROR");
}

const isoOrThrow = (v, what = "start") => {
    const d = new Date(String(v || ""));
    if (Number.isNaN(d.getTime())) throw new AdError(400, `Invalid ${what}.`, "INVALID_START");
    return d;
};
const hourAligned = (d) => (d.getTime() + IST_OFFSET_MS) % 3600000 === 0;

/* ------------------------------------------------------------------ catalogue */

export async function getSettings() {
    const { data } = await supabase.from("ad_settings").select("*").eq("id", true).single();
    return data;
}

export async function listPlacements({ includeInactive = false } = {}) {
    let q = supabase.from("ad_placements").select("*").order("sort_order");
    if (!includeInactive) q = q.eq("is_active", true);
    const { data, error } = await q;
    if (error) rpcFail(error, "listPlacements");
    return data || [];
}

async function placementByKey(key) {
    const { data, error } = await supabase.from("ad_placements").select("*").eq("key", String(key || "")).maybeSingle();
    if (error) rpcFail(error, "placementByKey");
    if (!data || !data.is_active) throw new AdError(404, RPC_ERRORS.PLACEMENT_UNAVAILABLE[1], "PLACEMENT_UNAVAILABLE");
    return data;
}

export async function availability({ key, month, day }) {
    const p = await placementByKey(key);
    if (day) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AdError(400, "Invalid date.", "INVALID_DATE");
        const { data, error } = await supabase.rpc("ad_availability_day", { p_placement: p.id, p_day: day });
        if (error) rpcFail(error, "availability_day");
        return { placement: p, hours: data || [] };
    }
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(month || "")) throw new AdError(400, "Invalid month.", "INVALID_DATE");
    const { data, error } = await supabase.rpc("ad_availability_month", { p_placement: p.id, p_month: month.length === 7 ? `${month}-01` : month });
    if (error) rpcFail(error, "availability_month");
    return { placement: p, days: data || [] };
}

/* ---------------------------------------------------------------------- quote */

async function walletBalance(sellerId) {
    const { data } = await supabase.rpc("wallet_get_status", { p_seller_id: sellerId }).single();
    return Number(data?.balance_due) || 0;
}

export async function quote({ sellerId, key, start, hours }) {
    const p = await placementByKey(key);
    const s = isoOrThrow(start);
    const n = Number(hours);
    if (!Number.isInteger(n)) throw new AdError(400, "Invalid duration.", "INVALID_DURATION");
    const { data, error } = await supabase.rpc("ad_quote", { p_placement: p.id, p_start: s.toISOString(), p_hours: n });
    if (error) rpcFail(error, "quote");

    const out = { ...data, placement: { key: p.key, name: p.name, kind: p.kind } };
    if (sellerId && data?.total != null) {
        const [balance, settings] = await Promise.all([walletBalance(sellerId), getSettings()]);
        const reserve = Number(settings?.min_wallet_reserve) || 0;
        out.wallet = {
            balance, reserve,
            balanceAfter: Math.round((balance - Number(data.total)) * 100) / 100,
            shortfall: Math.max(0, Math.ceil(Number(data.total) + reserve - balance)),
        };
        out.affordable = out.wallet.shortfall === 0;
    }
    return out;
}

/* ------------------------------------------------------------------- creative */

export async function buildCreative({ placement, sellerId, input }) {
    if (placement.kind === "product") {
        const id = String(input?.submissionId || "");
        if (!UUID_RE.test(id)) throw new AdError(400, "Choose one of your products to promote.", "INVALID_CREATIVE");
        return { submission_id: id };
    }

    const prefix = publicUrl(`ads/${sellerId}/`);
    const images = {};
    for (const shape of placement.aspect_keys) {
        const url = input?.images?.[shape];
        if (typeof url !== "string" || !url.startsWith(prefix)) {
            throw new AdError(400, "Upload the required banner image(s) first.", "INVALID_CREATIVE");
        }
        images[shape] = url;
    }

    const alt = String(input?.alt || "").replace(/\s+/g, " ").trim().slice(0, 140) || null;
    let link;
    if (input?.link?.type === "product") {
        const id = String(input.link.submissionId || "");
        if (!UUID_RE.test(id)) throw new AdError(400, "Choose which product the banner links to.", "INVALID_CREATIVE");
        const { data } = await supabase.from("seller_product_submissions")
            .select("generic_product_brand_id").eq("id", id).eq("seller_id", sellerId).maybeSingle();
        if (!data) throw new AdError(400, "That product isn't yours.", "INVALID_CREATIVE");
        link = { type: "brand_item", brand_item_id: data.generic_product_brand_id };
    } else {
        const { data } = await supabase.from("seller_profiles").select("shop_slug").eq("id", sellerId).maybeSingle();
        if (!data?.shop_slug) throw new AdError(400, "Your shop link isn't set up yet.", "INVALID_CREATIVE");
        link = { type: "shop", shop_slug: data.shop_slug };
    }
    return { images, link, alt };
}

/* ----------------------------------------------------------------------- book */

function broadcast() {
    try { getIO().emit("ads:changed", { t: Date.now() }); } catch { /* sockets optional */ }
}

export async function book({ sellerId, userId, key, start, hours, expectedTotal, creativeInput, idempotencyKey }) {
    if (!/^[\w-]{8,80}$/.test(String(idempotencyKey || ""))) throw new AdError(400, "Missing request id. Please try again.", "BAD_REQUEST");
    const total = Number(expectedTotal);
    if (!Number.isFinite(total) || total < 0) throw new AdError(400, "Missing the price you confirmed.", "BAD_REQUEST");

    const p = await placementByKey(key);
    const s = isoOrThrow(start);
    if (!hourAligned(s)) throw new AdError(400, RPC_ERRORS.INVALID_START[1], "INVALID_START");
    const n = Number(hours);
    if (!Number.isInteger(n)) throw new AdError(400, "Invalid duration.", "INVALID_DURATION");

    const creative = await buildCreative({ placement: p, sellerId, input: creativeInput });

    const { data, error } = await supabase.rpc("ad_book_slot", {
        p_seller: sellerId, p_placement: p.id, p_start: s.toISOString(), p_hours: n,
        p_expected_total: total, p_creative: creative, p_idem: idempotencyKey,
    });
    if (error) {
        if (String(error.message || "").startsWith("PRICE_CHANGED")) {
            const fresh = await quote({ sellerId, key, start, hours: n }).catch(() => null);
            try { rpcFail(error, "book"); } catch (e) { if (e instanceof AdError) e.details = { ...e.details, quote: fresh }; throw e; }
        }
        rpcFail(error, "book");
    }

    if (!data?.replayed) {
        notifyUser(userId, {
            type: "ad_booked", title: "Ad booked",
            body: `${p.name}: ${when(data.start)} to ${when(data.end)}. ${inr(data.amount)} was deducted from your credits.`,
            link: "/sell/ads",
        }).catch(() => { });
        notifyIfWalletJustBlocked({ sellerId, sellerUserId: userId }).catch(() => { });
        broadcast();
    }
    return data;
}

export async function listMyBookings(sellerId) {
    const { data, error } = await supabase.from("ad_bookings")
        .select("id, lane, starts_at, ends_at, status, subtotal, gst_amount, amount, refund_amount, removed_reason, removed_at, creative, created_at, placement:ad_placements(key, name, kind)")
        .eq("seller_id", sellerId).order("starts_at", { ascending: false }).limit(200);
    if (error) rpcFail(error, "listMyBookings");
    return data || [];
}

export async function liveNow(keys = null) {
    const { data, error } = await supabase.rpc("ad_live_now", { p_keys: keys });
    if (error) rpcFail(error, "liveNow");
    return data || {};
}

/* ---------------------------------------------------------------------- admin */

const num = (v, min, max, what) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new AdError(400, `Invalid ${what}.`, "BAD_REQUEST");
    return n;
};

export async function adminUpdatePlacement(id, body, adminId) {
    if (!UUID_RE.test(id)) throw new AdError(400, "Invalid placement.", "BAD_REQUEST");
    const patch = { updated_by: adminId };
    if (body.name !== undefined) patch.name = String(body.name).trim().slice(0, 80) || (() => { throw new AdError(400, "Name required.", "BAD_REQUEST"); })();
    if (body.description !== undefined) patch.description = String(body.description).slice(0, 400);
    if (body.baseRatePerHour !== undefined) patch.base_rate_per_hour = num(body.baseRatePerHour, 0, 1e6, "base rate");
    if (body.minMultiplier !== undefined) patch.min_multiplier = num(body.minMultiplier, 0.1, 50, "minimum multiplier");
    if (body.maxMultiplier !== undefined) patch.max_multiplier = num(body.maxMultiplier, 0.1, 50, "maximum multiplier");
    if (body.lanes !== undefined) patch.lanes = Math.trunc(num(body.lanes, 1, 20, "lanes"));
    if (body.minHours !== undefined) patch.min_hours = Math.trunc(num(body.minHours, 1, 720, "minimum hours"));
    if (body.maxHours !== undefined) patch.max_hours = Math.trunc(num(body.maxHours, 1, 720, "maximum hours"));
    if (body.maxDaysAhead !== undefined) patch.max_days_ahead = Math.trunc(num(body.maxDaysAhead, 1, 365, "days ahead"));
    if (body.isActive !== undefined) patch.is_active = !!body.isActive;
    const { data, error } = await supabase.from("ad_placements").update(patch).eq("id", id).select().maybeSingle();
    if (error) {
        if (error.code === "23514") throw new AdError(400, "Those values aren't allowed (check min/max multipliers and hours).", "BAD_REQUEST");
        rpcFail(error, "adminUpdatePlacement");
    }
    if (!data) throw new AdError(404, "Placement not found.", "NOT_FOUND");
    broadcast();
    return data;
}

export async function adminUpdateSettings(body, adminId) {
    const patch = { updated_at: new Date().toISOString(), updated_by: adminId };
    if (body.gstPercent !== undefined) patch.gst_percent = num(body.gstPercent, 0, 40, "GST");
    if (body.minWalletReserve !== undefined) patch.min_wallet_reserve = num(body.minWalletReserve, 0, 1e6, "reserve");
    if (body.demandExponent !== undefined) patch.demand_exponent = num(body.demandExponent, 0.1, 5, "demand exponent");
    const { data, error } = await supabase.from("ad_settings").update(patch).eq("id", true).select().single();
    if (error) rpcFail(error, "adminUpdateSettings");
    return data;
}

export async function adminListOverrides(placementId) {
    let q = supabase.from("ad_price_overrides").select("*").is("revoked_at", null).order("created_at", { ascending: false }).limit(200);
    if (placementId) q = q.eq("placement_id", placementId);
    const { data, error } = await q;
    if (error) rpcFail(error, "adminListOverrides");
    return data || [];
}

export async function adminCreateOverride(body, adminId) {
    if (!UUID_RE.test(String(body.placementId || ""))) throw new AdError(400, "Invalid placement.", "BAD_REQUEST");
    const from = isoOrThrow(body.from, "start"), to = isoOrThrow(body.to, "end");
    if (!hourAligned(from) || !hourAligned(to) || to <= from) throw new AdError(400, "Use whole IST hours, with the end after the start.", "BAD_REQUEST");
    const kind = String(body.kind);
    const reason = String(body.reason || "").trim();
    if (reason.length < 3) throw new AdError(400, "A reason is required. Sellers and admins will see it.", "REASON_REQUIRED");
    const row = { placement_id: body.placementId, during: `[${from.toISOString()},${to.toISOString()})`, kind, reason, created_by: adminId };
    if (kind === "fixed") row.fixed_rate = num(body.fixedRate, 0, 1e6, "fixed rate");
    else if (kind === "multiplier") row.multiplier = num(body.multiplier, 0.1, 50, "multiplier");
    else if (kind !== "blackout") throw new AdError(400, "Invalid override type.", "BAD_REQUEST");
    const { data, error } = await supabase.from("ad_price_overrides").insert(row).select().single();
    if (error) rpcFail(error, "adminCreateOverride");
    broadcast();
    return data;
}

export async function adminRevokeOverride(id, adminId) {
    if (!UUID_RE.test(id)) throw new AdError(400, "Invalid override.", "BAD_REQUEST");
    const { data, error } = await supabase.from("ad_price_overrides")
        .update({ revoked_at: new Date().toISOString() }).eq("id", id).is("revoked_at", null).select("id").maybeSingle();
    if (error) rpcFail(error, "adminRevokeOverride");
    if (!data) throw new AdError(404, "Override not found.", "NOT_FOUND");
    broadcast();
}

export async function adminPricing({ placementId, day }) {
    if (!UUID_RE.test(placementId) || !/^\d{4}-\d{2}-\d{2}$/.test(day || "")) throw new AdError(400, "Invalid request.", "BAD_REQUEST");
    const from = new Date(`${day}T00:00:00+05:30`), to = new Date(from.getTime() + 24 * 3600000);
    const { data, error } = await supabase.rpc("ad_price_grid", { p_placement: placementId, p_from: from.toISOString(), p_to: to.toISOString() });
    if (error) rpcFail(error, "adminPricing");
    return data || [];
}

export async function adminListBookings({ status, placementId, sellerId, liveOnly, limit = 100, offset = 0 }) {
    let q = supabase.from("ad_bookings")
        .select("id, lane, starts_at, ends_at, status, subtotal, gst_amount, amount, refund_amount, price_breakdown, creative, removed_reason, removed_at, created_at, placement:ad_placements(id, key, name, kind), seller:seller_profiles(id, display_name, shop_slug)", { count: "exact" })
        .order("starts_at", { ascending: false }).range(offset, offset + Math.min(limit, 200) - 1);
    if (status === "active" || status === "removed") q = q.eq("status", status);
    if (UUID_RE.test(placementId || "")) q = q.eq("placement_id", placementId);
    if (UUID_RE.test(sellerId || "")) q = q.eq("seller_id", sellerId);
    if (liveOnly) { const now = new Date().toISOString(); q = q.eq("status", "active").lte("starts_at", now).gt("ends_at", now); }
    const { data, error, count } = await q;
    if (error) rpcFail(error, "adminListBookings");
    return { bookings: data || [], total: count ?? 0 };
}

export async function adminRemoveBooking({ id, adminId, reason, refundMode }) {
    if (!UUID_RE.test(id)) throw new AdError(400, "Invalid booking.", "BAD_REQUEST");
    const { data, error } = await supabase.rpc("ad_admin_remove", {
        p_booking: id, p_admin: adminId, p_reason: String(reason || ""), p_refund_mode: String(refundMode || "none"),
    });
    if (error) rpcFail(error, "adminRemoveBooking");

    // Tell the seller what happened and why (best-effort, after the commit).
    try {
        const { data: sp } = await supabase.from("seller_profiles").select("user_id").eq("id", data.seller_id).maybeSingle();
        if (sp?.user_id) {
            await notifyUser(sp.user_id, {
                type: "ad_removed", title: "Your ad was removed",
                body: `"${data.placement}" (${when(data.start)} to ${when(data.end)}) was removed by BBM. Reason: ${String(reason).trim()}.` +
                    (Number(data.refund) > 0 ? ` ${inr(data.refund)} was refunded to your credits.` : " No refund was issued."),
                link: "/sell/ads",
            });
            await notifyIfWalletJustBlocked({ sellerId: data.seller_id, sellerUserId: sp.user_id });
        }
    } catch (e) { console.error("[ads] removal notify failed:", e?.message || e); }
    broadcast();
    return data;
}