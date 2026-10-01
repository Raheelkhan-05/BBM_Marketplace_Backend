// controllers/adminDisputes.controller.js
// Admin-only. Mount behind requireAuth + requireAdmin (see routes snippet).
import { supabase } from "../config/supabase.js";
import { notifyUser, notifyOrderChanged, notifyUserOrdersChanged } from "../services/realtimeBroadcast.js";
import { notifyIfWalletJustBlocked } from "../services/walletNotifications.service.js";
import { releaseDueSettlements } from "../services/settlement.service.js";

const inr = (n) => `₹${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const RESOLVE_ERRORS = {
    DISPUTE_NOT_FOUND: [404, "Dispute not found."],
    ALREADY_RESOLVED: [400, "This dispute has already been resolved."],
    NOTE_REQUIRED: [400, "Please write a resolution note — both parties will see it."],
    INVALID_AMOUNT: [400, "Enter valid amounts (at least one of refund / seller payout must be above zero)."],
    REFUND_EXCEEDS_HELD: [400, "Refund can't be more than the amount the buyer paid."],
    PAYOUT_EXCEEDS_SELLER_AMOUNT: [400, "Seller payout can't be more than the seller's receivable for this order."],
    AMOUNT_EXCEEDS_HELD: [400, "Refund + seller payout can't be more than the amount held."],
    NOT_ON_HOLD: [400, "This order's payment isn't on hold, so it can't be settled from here."],
};

async function sellerUserId(sellerId) {
    const { data } = await supabase.from("seller_profiles").select("user_id").eq("id", sellerId).maybeSingle();
    return data?.user_id || null;
}

// GET /api/admin/disputes?status=open|under_review|resolved|all&q=&page=1&pageSize=20
export async function adminListDisputes(req, res) {
    const status = ["open", "under_review", "resolved", "all"].includes(req.query.status) ? req.query.status : "open";
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 50);
    const q = String(req.query.q || "").replace(/[^\w\- ]/g, "").trim();

    let query = supabase.from("order_disputes").select(`
        id, dispute_number, order_id, buyer_id, seller_id, category, desired_resolution, status,
        seller_responded_at, resolution_type, refund_amount, seller_payout_amount, resolved_at, created_at,
        order:orders ( order_number, order_type, total_amount, delivered_at )
    `, { count: "exact" });

    if (status !== "all") query = query.eq("status", status);

    if (q) {
        const { data: matched } = await supabase.from("orders").select("id").ilike("order_number", `%${q}%`).limit(50);
        const ids = (matched || []).map((o) => o.id);
        query = ids.length ? query.or(`dispute_number.ilike.%${q}%,order_id.in.(${ids.join(",")})`) : query.ilike("dispute_number", `%${q}%`);
    }

    // Work queue is oldest-first (FIFO); history is newest-first.
    query = query.order(status === "resolved" ? "resolved_at" : "created_at", { ascending: status !== "resolved" });
    const from = (page - 1) * pageSize;
    query = query.range(from, from + pageSize - 1);

    const countFor = (s) => supabase.from("order_disputes").select("id", { count: "exact", head: true }).eq("status", s);
    const [{ data, error, count }, open, review, resolved] = await Promise.all([query, countFor("open"), countFor("under_review"), countFor("resolved")]);
    if (error) return res.status(500).json({ success: false, message: error.message });

    const rows = data || [];
    const buyerIds = [...new Set(rows.map((r) => r.buyer_id))];
    const sellerIds = [...new Set(rows.map((r) => r.seller_id))];
    const [{ data: buyers }, { data: sellers }] = await Promise.all([
        buyerIds.length ? supabase.from("profiles").select("id, name").in("id", buyerIds) : { data: [] },
        sellerIds.length ? supabase.from("seller_profiles").select("id, display_name").in("id", sellerIds) : { data: [] },
    ]);
    const buyerName = new Map((buyers || []).map((b) => [b.id, b.name]));
    const sellerName = new Map((sellers || []).map((s) => [s.id, s.display_name]));

    res.json({
        success: true,
        total: count ?? rows.length, page, pageSize,
        counts: { open: open.count || 0, under_review: review.count || 0, resolved: resolved.count || 0 },
        disputes: rows.map((r) => ({ ...r, buyer_name: buyerName.get(r.buyer_id) || null, seller_name: sellerName.get(r.seller_id) || null })),
    });
}

// GET /api/admin/disputes/:id — everything the admin needs to decide
export async function adminGetDispute(req, res) {
    const { data: dispute, error } = await supabase.from("order_disputes").select("*").eq("id", req.params.id).maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!dispute) return res.status(404).json({ success: false, message: "Dispute not found." });

    const [orderRes, disputeEventsRes, orderEventsRes, ledgerRes, walletTxRes, buyerRes, buyerBizRes, sellerRes] = await Promise.all([
        supabase.from("orders").select("*, items:order_items ( *, submission:seller_product_submissions ( freight_terms ) )").eq("id", dispute.order_id).maybeSingle(),
        supabase.from("order_dispute_events").select("*").eq("dispute_id", dispute.id).order("created_at"),
        supabase.from("order_events").select("*").eq("order_id", dispute.order_id).order("created_at"),
        supabase.from("order_settlement_entries").select("*").eq("order_id", dispute.order_id).order("created_at"),
        supabase.from("wallet_transactions").select("id, type, amount, note, breakdown, created_at").eq("order_id", dispute.order_id).order("created_at"),
        supabase.from("profiles").select("id, name, email, email_verified, phone, phone_verified").eq("id", dispute.buyer_id).maybeSingle(),
        supabase.from("business_profiles").select("*").eq("user_id", dispute.buyer_id).maybeSingle(),
        supabase.from("seller_profiles").select("*").eq("id", dispute.seller_id).maybeSingle(),
    ]);
    const order = orderRes.data;
    if (!order) return res.status(404).json({ success: false, message: "The order for this dispute no longer exists." });
    const seller = sellerRes.data;

    const [sellerUserRes, sellerBizRes, walletRes, group, buyerPast, sellerPast, sellerDelivered, sellerDisputeTotal, buyerDisputeTotal] = await Promise.all([
        seller?.user_id ? supabase.from("profiles").select("id, name, email, email_verified, phone, phone_verified").eq("id", seller.user_id).maybeSingle() : { data: null },
        seller?.user_id ? supabase.from("business_profiles").select("*").eq("user_id", seller.user_id).maybeSingle() : { data: null },
        supabase.rpc("wallet_get_status", { p_seller_id: dispute.seller_id }).single(),
        order.order_group_id
            ? supabase.from("order_groups").select("id, group_number, total_amount, payment_status").eq("id", order.order_group_id).maybeSingle()
            : { data: null },
        supabase.from("order_disputes").select("id, dispute_number, category, status, resolution_type, created_at").eq("buyer_id", dispute.buyer_id).neq("id", dispute.id).order("created_at", { ascending: false }).limit(5),
        supabase.from("order_disputes").select("id, dispute_number, category, status, resolution_type, created_at").eq("seller_id", dispute.seller_id).neq("id", dispute.id).order("created_at", { ascending: false }).limit(5),
        supabase.from("orders").select("id", { count: "exact", head: true }).eq("seller_id", dispute.seller_id).eq("status", "delivered"),
        supabase.from("order_disputes").select("id", { count: "exact", head: true }).eq("seller_id", dispute.seller_id),
        supabase.from("order_disputes").select("id", { count: "exact", head: true }).eq("buyer_id", dispute.buyer_id),
    ]);

    res.json({
        success: true,
        dispute,
        order,
        orderEvents: orderEventsRes.data || [],
        disputeEvents: disputeEventsRes.data || [],
        ledger: ledgerRes.data || [],
        walletTransactions: walletTxRes.data || [],
        orderGroup: group.data || null,
        buyer: {
            profile: buyerRes.data || null,
            business: buyerBizRes.data || null,
            disputeCount: buyerDisputeTotal.count || 0,
            pastDisputes: buyerPast.data || [],
        },
        seller: {
            shop: seller || null,
            user: sellerUserRes.data || null,
            business: sellerBizRes.data || null,
            wallet: walletRes.error ? null : walletRes.data,
            deliveredOrderCount: sellerDelivered.count || 0,
            disputeCount: sellerDisputeTotal.count || 0,
            pastDisputes: sellerPast.data || [],
        },
    });
}

// POST /api/admin/disputes/:id/review — claim the case (open -> under_review)
export async function adminStartReview(req, res) {
    const { data: dispute, error } = await supabase.from("order_disputes")
        .update({ status: "under_review", assigned_admin_id: req.user.id, updated_at: new Date().toISOString() })
        .eq("id", req.params.id).eq("status", "open").select("id, order_id, buyer_id, seller_id").maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!dispute) return res.status(400).json({ success: false, message: "This dispute is no longer open." });

    await supabase.from("orders").update({ dispute_status: "under_review" }).eq("id", dispute.order_id);
    await supabase.from("order_dispute_events").insert({
        dispute_id: dispute.id, order_id: dispute.order_id, actor_role: "admin", actor_user_id: req.user.id,
        event_type: "under_review", note: "Our team has started reviewing this dispute.",
    });

    const sUser = await sellerUserId(dispute.seller_id);
    await notifyOrderChanged(dispute.order_id, { status: "delivered", dispute: "under_review" });
    await notifyUser(dispute.buyer_id, { type: "dispute_under_review", title: "Your dispute is under review", body: "Our team is looking into it and will share the decision here.", link: `/orders/${dispute.order_id}` });
    if (sUser) await notifyUser(sUser, { type: "dispute_under_review", title: "A dispute on your order is under review", body: "Please make sure you've shared your response and any proof.", link: `/seller/orders/${dispute.order_id}` });
    await notifyUserOrdersChanged(dispute.buyer_id);
    if (sUser) await notifyUserOrdersChanged(sUser);

    res.json({ success: true });
}

// POST /api/admin/disputes/:id/message  { message } — visible to buyer AND seller
export async function adminPostMessage(req, res) {
    const message = String(req.body?.message || "").trim();
    if (message.length < 3) return res.status(400).json({ success: false, message: "Write a message first." });
    if (message.length > 1000) return res.status(400).json({ success: false, message: "Message is too long (max 1000 characters)." });

    const { data: dispute } = await supabase.from("order_disputes").select("id, order_id, buyer_id, seller_id, status").eq("id", req.params.id).maybeSingle();
    if (!dispute) return res.status(404).json({ success: false, message: "Dispute not found." });
    if (dispute.status === "resolved") return res.status(400).json({ success: false, message: "This dispute is already resolved." });

    const { error } = await supabase.from("order_dispute_events").insert({
        dispute_id: dispute.id, order_id: dispute.order_id, actor_role: "admin", actor_user_id: req.user.id, event_type: "admin_message", note: message,
    });
    if (error) return res.status(500).json({ success: false, message: "Couldn't post the message." });

    const sUser = await sellerUserId(dispute.seller_id);
    await notifyOrderChanged(dispute.order_id, { status: "delivered", dispute: "message" });
    await notifyUser(dispute.buyer_id, { type: "dispute_message", title: "Message from our team on your dispute", body: message.slice(0, 140), link: `/orders/${dispute.order_id}` });
    if (sUser) await notifyUser(sUser, { type: "dispute_message", title: "Message from our team on a dispute", body: message.slice(0, 140), link: `/seller/orders/${dispute.order_id}` });
    res.json({ success: true });
}

// POST /api/admin/disputes/:id/resolve
// { refundAmount, sellerPayoutAmount, resolutionNote, internalNote, reverseCommission }
export async function adminResolveDispute(req, res) {
    const { refundAmount, sellerPayoutAmount, resolutionNote, internalNote, reverseCommission } = req.body || {};
    const refund = Number(refundAmount || 0);
    const payout = Number(sellerPayoutAmount || 0);
    if (!Number.isFinite(refund) || !Number.isFinite(payout)) {
        return res.status(400).json({ success: false, message: "Enter valid amounts." });
    }

    const { data, error } = await supabase.rpc("admin_resolve_dispute", {
        p_dispute_id: req.params.id, p_admin_id: req.user.id,
        p_refund_amount: refund, p_seller_payout_amount: payout,
        p_resolution_note: String(resolutionNote || ""), p_internal_note: internalNote ? String(internalNote) : null,
    });
    if (error) {
        const [status, message] = RESOLVE_ERRORS[(error.message || "").trim()] || [500, "Couldn't resolve the dispute."];
        if (status === 500) console.error("[adminResolveDispute] rpc failed:", error);
        return res.status(status).json({ success: false, code: (error.message || "").trim(), message });
    }
    const r = Array.isArray(data) ? data[0] : data;

    // Optional: give the seller their Promotion & Visibility fee back (typically on a full refund).
    let commissionReversed = false;
    if (reverseCommission && r && Number(r.r_refund) > 0) {
        const { error: revErr } = await supabase.rpc("wallet_reverse_commission", { p_order_id: r.r_order_id });
        if (revErr) console.error("[adminResolveDispute] wallet_reverse_commission failed:", revErr.message);
        else {
            commissionReversed = true;
            if (r.r_seller_user_id) await notifyIfWalletJustBlocked({ sellerId: r.r_seller_id, sellerUserId: r.r_seller_user_id });
        }
    }

    // Notify both parties with the outcome in plain words.
    const buyerBody = {
        release_to_seller: "After reviewing, we found no grounds for a refund. The payment has been released to the seller.",
        full_refund: `We've approved a full refund of ${inr(r?.r_refund)} for this order.`,
        partial_refund: `We've approved a partial refund of ${inr(r?.r_refund)} for this order.`,
        no_financial_action: "Our team has reviewed and closed your dispute.",
    }[r?.r_resolution_type] || "Your dispute has been resolved.";
    const sellerBody = {
        release_to_seller: `Dispute resolved in your favour — ${inr(r?.r_payout)} has been released to your bank account.`,
        full_refund: "Dispute resolved — the buyer has been fully refunded and no payout is due for this order.",
        partial_refund: `Dispute resolved — ${inr(r?.r_payout)} has been released to you and ${inr(r?.r_refund)} refunded to the buyer.`,
        no_financial_action: "Our team has reviewed and closed this dispute.",
    }[r?.r_resolution_type] || "The dispute has been resolved.";

    if (r) {
        await notifyOrderChanged(r.r_order_id, { status: "delivered", dispute: "resolved" });
        await notifyUser(r.r_buyer_id, { type: "dispute_resolved", title: `Dispute resolved — order ${r.r_order_number}`, body: buyerBody, link: `/orders/${r.r_order_id}` });
        await notifyUserOrdersChanged(r.r_buyer_id);
        if (r.r_seller_user_id) {
            await notifyUser(r.r_seller_user_id, { type: "dispute_resolved", title: `Dispute resolved — order ${r.r_order_number}`, body: sellerBody, link: `/seller/orders/${r.r_order_id}` });
            await notifyUserOrdersChanged(r.r_seller_user_id);
        }
    }

    res.json({
        success: true, message: "Dispute resolved.", resolution: r ? {
            type: r.r_resolution_type, refund: r.r_refund, payout: r.r_payout, retained: r.r_retained, commissionReversed,
        } : null
    });
}

// GET /api/admin/disputes/ledger?type=seller_payout|buyer_refund&page=1
export async function adminListLedger(req, res) {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = 30;
    let query = supabase.from("order_settlement_entries").select(`
        id, order_id, dispute_id, entry_type, seller_id, buyer_id, amount, reference, mode, status, trigger_source, note, created_at,
        order:orders ( order_number )
    `, { count: "exact" }).order("created_at", { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
    if (["seller_payout", "buyer_refund"].includes(req.query.type)) query = query.eq("entry_type", req.query.type);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    const rows = data || [];

    const sellerIds = [...new Set(rows.map((r) => r.seller_id).filter(Boolean))];
    const buyerIds = [...new Set(rows.map((r) => r.buyer_id).filter(Boolean))];
    const [{ data: sellers }, { data: buyers }] = await Promise.all([
        sellerIds.length ? supabase.from("seller_profiles").select("id, display_name").in("id", sellerIds) : { data: [] },
        buyerIds.length ? supabase.from("profiles").select("id, name").in("id", buyerIds) : { data: [] },
    ]);
    const sName = new Map((sellers || []).map((s) => [s.id, s.display_name]));
    const bName = new Map((buyers || []).map((b) => [b.id, b.name]));

    // How much is currently parked, so the admin sees the exposure at a glance.
    const { data: held } = await supabase.from("orders").select("settlement_seller_amount, settlement_status").in("settlement_status", ["held", "disputed"]);
    const sum = (st) => (held || []).filter((o) => o.settlement_status === st).reduce((a, o) => a + (Number(o.settlement_seller_amount) || 0), 0);

    res.json({
        success: true, total: count ?? rows.length, page, pageSize,
        summary: { heldAmount: sum("held"), disputedAmount: sum("disputed"), heldCount: (held || []).filter((o) => o.settlement_status === "held").length, disputedCount: (held || []).filter((o) => o.settlement_status === "disputed").length },
        entries: rows.map((r) => ({ ...r, seller_name: sName.get(r.seller_id) || null, buyer_name: bName.get(r.buyer_id) || null })),
    });
}

// POST /api/admin/disputes/settlements/run — run the payout sweep now
export async function adminRunSettlementSweep(req, res) {
    try {
        const released = await releaseDueSettlements();
        res.json({ success: true, releasedCount: released.length, totalAmount: released.reduce((a, r) => a + (Number(r.r_amount) || 0), 0) });
    } catch (e) {
        console.error("[adminRunSettlementSweep]", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't run the payout sweep." });
    }
}