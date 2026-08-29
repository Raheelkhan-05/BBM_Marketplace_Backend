// controllers/admin/paymentVerification.controller.js
//
// Admin review queue for UPI payment proofs. Gate all these routes behind
// your existing admin-auth middleware (profiles.role = 'admin'), same as
// your other admin/review endpoints for hs_categories etc.
//
// Wire into your admin router, e.g.:
//   router.get("/admin/payment-proofs", requireAdmin, listPendingPaymentProofs);
//   router.post("/admin/payment-proofs/:id/verify", requireAdmin, verifyPayment);
//   router.post("/admin/payment-proofs/:id/reject", requireAdmin, rejectPayment);
import { supabase } from "../config/supabase.js";
import { notifyUser, notifyUserOrdersChanged } from "../services/realtimeBroadcast.js";

const VERIFY_ERROR_MAP = {
    PROOF_NOT_FOUND: { status: 404, message: "Payment proof not found." },
    ALREADY_REVIEWED: { status: 400, message: "This payment proof has already been reviewed." },
    ORDER_NOT_FOUND: { status: 404, message: "Underlying order not found." },
    INVALID_DECISION: { status: 400, message: "Invalid decision." },
};
function mapVerifyError(error) {
    return VERIFY_ERROR_MAP[(error?.message || "").trim()] || { status: 500, message: "Couldn't process this decision. Please try again." };
}

// GET /api/admin/payment-proofs?status=pending
export async function listPendingPaymentProofs(req, res) {
    const status = req.query.status || "pending";
    const { data, error } = await supabase
        .from("payment_proofs")
        .select(`
            id, utr_number, screenshot_url, amount_claimed, status, admin_note, created_at, reviewed_at,
            order_id, order_group_id,
            order:orders (
                id, order_number, total_amount, status, buyer_contact_name, buyer_contact_phone,
                order_group_id,
                seller:seller_profiles ( display_name, shop_slug )
            ),
            group:order_groups (
                id, group_number
            )
        `)
        .eq("status", status)
        .order("created_at", { ascending: true });

    if (error) return res.status(500).json({ success: false, message: error.message });

    // Group proofs (order_id null) don't get an `order` via the FK embed
    // above — resolve their sibling orders separately so the admin still
    // sees a buyer, a total, and every seller the one UTR covers.
    const groupProofIds = (data || []).filter(p => !p.order_id && p.order_group_id).map(p => p.order_group_id);
    let ordersByGroup = {};
    if (groupProofIds.length) {
        const { data: groupOrders } = await supabase
            .from("orders")
            .select("id, order_number, total_amount, status, buyer_contact_name, buyer_contact_phone, order_group_id, seller:seller_profiles ( display_name, shop_slug )")
            .in("order_group_id", groupProofIds);
        ordersByGroup = (groupOrders || []).reduce((acc, o) => {
            (acc[o.order_group_id] ||= []).push(o);
            return acc;
        }, {});
    }

    const proofs = (data || []).map((p) => {
        const groupNumber = p.group?.group_number ?? null;
        if (p.order) return { ...p, groupOrders: null, groupNumber };
        const orders = ordersByGroup[p.order_group_id] || [];
        return {
            ...p,
            order: orders[0] || null, // primary, for the existing card layout
            groupOrders: orders,      // full set, for a "covers N sellers" line
            groupNumber,
        };
    });

    res.json({ success: true, proofs });
}

// POST /api/admin/payment-proofs/:id/verify
// POST /api/admin/payment-proofs/:id/verify
export async function verifyPayment(req, res) {
    const { note } = req.body || {};
    const { error } = await supabase.rpc("admin_verify_payment", {
        p_proof_id: req.params.id,
        p_admin_id: req.user.id,
        p_decision: "verified",
        p_admin_note: note || null,
    });
    if (error) {
        const mapped = mapVerifyError(error);
        return res.status(mapped.status).json({ success: false, code: error.message, message: mapped.message });
    }

    // NEW — this is the actual "payment confirmed" moment. Commission gets
    // added to the wallet HERE, not at order placement. Covers both shapes:
    //   - single-order proof (order_id set)
    //   - cart/group proof (order_group_id set) — one UTR can cover several
    //     seller orders at once, so accrue for every sibling order in the group
    // This is the actual "payment confirmed" moment for standard orders.
    // It's also the first time the seller is told about the order at all —
    // placeOrder() deliberately skips notifying the seller while the order
    // sits in awaiting_payment. Covers both shapes:
    //   - single-order proof (order_id set)
    //   - cart/group proof (order_group_id set) — one UTR can cover several
    //     seller orders at once, so notify + accrue for every sibling order
    const { data: proof } = await supabase
        .from("payment_proofs")
        .select("order_id, order_group_id")
        .eq("id", req.params.id)
        .maybeSingle();

    const orderIds = [];
    if (proof?.order_id) {
        orderIds.push(proof.order_id);
    } else if (proof?.order_group_id) {
        const { data: groupOrders } = await supabase
            .from("orders").select("id").eq("order_group_id", proof.order_group_id);
        orderIds.push(...(groupOrders || []).map((o) => o.id));
    }

    for (const orderId of orderIds) {
        await supabase.rpc("wallet_accrue_commission", { p_order_id: orderId });

        const { data: order } = await supabase
            .from("orders")
            .select("order_number, seller:seller_profiles ( user_id )")
            .eq("id", orderId)
            .maybeSingle();
        const sellerUserId = order?.seller?.user_id;
        if (sellerUserId) {
            await notifyUser(sellerUserId, {
                type: "order_placed",
                title: `New order: ${order.order_number}`,
                body: "Check your Sales Orders to confirm it.",
                link: `/seller/orders/${orderId}`,
            });
            await notifyUserOrdersChanged(sellerUserId);
        }
    }

    res.json({ success: true, message: "Payment verified. The seller has been notified." });
}

// POST /api/admin/payment-proofs/:id/reject
export async function rejectPayment(req, res) {
    const { note } = req.body || {};
    if (!note || !note.trim()) {
        return res.status(400).json({ success: false, message: "Please give a reason so the buyer knows what to fix." });
    }
    const { error } = await supabase.rpc("admin_verify_payment", {
        p_proof_id: req.params.id,
        p_admin_id: req.user.id,
        p_decision: "rejected",
        p_admin_note: note.trim(),
    });
    if (error) {
        const mapped = mapVerifyError(error);
        return res.status(mapped.status).json({ success: false, code: error.message, message: mapped.message });
    }
    res.json({ success: true, message: "Payment rejected. The buyer has been notified to resubmit." });
}