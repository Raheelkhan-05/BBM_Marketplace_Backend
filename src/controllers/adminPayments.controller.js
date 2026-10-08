// src/controllers/adminPayments.controller.js
// Read-only visibility plus two safe actions (re-check a payment, retry a failed refund).
// There is deliberately NO "mark as paid" action: money is only ever applied from the gateway.
import { supabase } from "../config/supabase.js";
import { reconcileAttempt } from "../services/payments.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTEMPT_STATUSES = ["created", "initiated", "pending", "success", "failed", "expired", "needs_review"];
const REFUND_STATUSES = ["queued", "processing", "success", "failed", "manual_required"];
const PAGE_SIZE = 30;

const pageOf = (req) => Math.max(parseInt(req.query.page, 10) || 1, 1);

// GET /api/admin/payments/attempts?status=needs_review&page=1
export async function listAttempts(req, res) {
    const page = pageOf(req);
    let q = supabase.from("payment_attempts").select(
        "id, merchant_txn_no, purpose, order_id, order_group_id, seller_id, user_id, amount_paise, status, apply_outcome, gateway_response_code, gateway_message, gateway_txn_id, payment_mode, refunded_paise, expires_at, completed_at, created_at",
        { count: "exact" },
    ).order("created_at", { ascending: false }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (ATTEMPT_STATUSES.includes(req.query.status)) q = q.eq("status", req.query.status);

    const { data, error, count } = await q;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, total: count ?? 0, page, pageSize: PAGE_SIZE, attempts: data || [] });
}

// POST /api/admin/payments/attempts/:id/recheck — asks JioPay for the authoritative status now
export async function recheckAttempt(req, res) {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: "Invalid id." });
    const { data: a } = await supabase.from("payment_attempts")
        .select("id, merchant_txn_no, amount_paise, status, expires_at").eq("id", id).maybeSingle();
    if (!a) return res.status(404).json({ success: false, message: "Payment attempt not found." });

    try {
        const result = await reconcileAttempt({
            id: a.id, ref: a.merchant_txn_no, amountPaise: Number(a.amount_paise), status: a.status, expiresAt: a.expires_at,
        });
        if (!result) return res.status(502).json({ success: false, message: "Couldn't reach the gateway. Try again shortly." });
        res.json({ success: true, outcome: result.outcome });
    } catch (e) {
        console.error("[adminPayments] recheck failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Re-check failed." });
    }
}

// GET /api/admin/payments/refunds?status=failed&page=1
export async function listRefunds(req, res) {
    const page = pageOf(req);
    let q = supabase.from("payment_refunds").select(
        "id, attempt_id, order_id, merchant_txn_no, amount_paise, reason, status, attempts, max_attempts, next_attempt_at, gateway_response_code, last_error, completed_at, created_at",
        { count: "exact" },
    ).order("created_at", { ascending: false }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (REFUND_STATUSES.includes(req.query.status)) q = q.eq("status", req.query.status);

    const { data, error, count } = await q;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, total: count ?? 0, page, pageSize: PAGE_SIZE, refunds: data || [] });
}

// POST /api/admin/payments/refunds/:id/retry — only for refunds that gave up.
// attempts is kept (not reset) so the next try still pre-checks the gateway first: no double refunds.
export async function retryRefund(req, res) {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: "Invalid id." });
    const { data: r } = await supabase.from("payment_refunds").select("id, status, attempts, attempt_id").eq("id", id).maybeSingle();
    if (!r) return res.status(404).json({ success: false, message: "Refund not found." });
    if (r.status !== "failed" || !r.attempt_id) {
        return res.status(400).json({ success: false, message: "Only failed refunds linked to a payment can be retried." });
    }
    const { error } = await supabase.from("payment_refunds")
        .update({ status: "queued", next_attempt_at: new Date().toISOString(), max_attempts: r.attempts + 3, last_error: null })
        .eq("id", id).eq("status", "failed");
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, message: "Refund re-queued." });
}