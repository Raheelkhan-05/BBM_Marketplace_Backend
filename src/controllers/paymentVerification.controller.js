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
            order:orders (
                id, order_number, total_amount, status, buyer_contact_name, buyer_contact_phone,
                seller:seller_profiles ( display_name, shop_slug )
            )
        `)
        .eq("status", status)
        .order("created_at", { ascending: true });

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, proofs: data || [] });
}

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