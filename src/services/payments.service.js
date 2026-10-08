// src/services/payments.service.js
//
// Orchestrates JioPay payments. Rules this file never breaks:
//   1. Money state changes ONLY through the SQL function payment_process_result() (atomic, idempotent).
//   2. "Paid" only ever comes from a hash-verified gateway response with a configured success code,
//      for the exact amount we stored server-side — and (by default) re-confirmed via the status API.
//   3. The browser return (B2B) never credits anything; it only triggers an authoritative status check.
//   4. Notifications are best-effort and run AFTER the database commit; they can never undo a payment.
import { supabase } from "../config/supabase.js";
import { jiopayConfig as cfg, assertJiopayConfigured } from "../config/jiopay.js";
import {
    initiateSale, statusCheck, issueRefund, verifyPayloadHash, classifyCode,
    normalizeGatewayPayload, sanitizePayload,
} from "./jiopay.client.js";
import { notifyUser, notifyUserOrdersChanged } from "./realtimeBroadcast.js";
import { notifyAdmins } from "./notifications.service.js";
import { notifyIfWalletJustBlocked } from "./walletNotifications.service.js";
import { sendOrderUpdateWhatsApp } from "./whatsapp.service.js";

export class PaymentError extends Error {
    constructor(status, message, code) {
        super(message);
        this.name = "PaymentError";
        this.status = status;
        this.code = code || "PAYMENT_ERROR";
    }
}

const REF_RE = /^BBM[0-9A-F]{17}$/;
export const isValidRef = (s) => typeof s === "string" && REF_RE.test(s);

const LIVE = ["created", "initiated", "pending"];
const inr = (paise) => `₹${((Number(paise) || 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

async function safely(label, fn) {
    try { await fn(); } catch (e) { console.error(`[payments] ${label} failed:`, e?.message || e); }
}

async function alertAdmins(title, body) {
    await safely("admin alert", () => notifyAdmins({ type: "payment_alert", title, body, link: "/payments" }));
}

/* ===================================================================== checkout */

const CREATE_ERRORS = {
    ORDER_NOT_FOUND: [404, "Order not found."],
    GROUP_NOT_FOUND: [404, "Order not found."],
    SELLER_NOT_FOUND: [403, "Seller account not found."],
    ORDER_IN_GROUP: [400, "This order is part of a cart checkout. Please pay for the whole cart."],
    NOT_AWAITING_PAYMENT: [400, "This order isn't waiting for payment."],
    INVALID_AMOUNT: [400, "Enter a valid amount between ₹1 and ₹10,00,000."],
    TOO_MANY_ATTEMPTS: [429, "Too many payment attempts. Please wait a few minutes and try again."],
};

// purpose: 'order' | 'order_group' | 'wallet_topup'
export async function createCheckout({ purpose, userId, targetId, amountPaise = null }) {
    assertJiopayConfigured();

    const { data: created, error } = await supabase
        .rpc("payment_create_attempt", {
            p_purpose: purpose, p_user_id: userId, p_target_id: targetId,
            p_amount_paise: amountPaise, p_ttl_minutes: cfg.attemptTtlMinutes,
        })
        .single();

    if (error) {
        const code = (error.message || "").trim();
        const mapped = CREATE_ERRORS[code];
        if (mapped) throw new PaymentError(mapped[0], mapped[1], code);
        console.error("[payments] payment_create_attempt failed:", error.message);
        throw new PaymentError(500, "Couldn't start the payment. Please try again.", "CREATE_FAILED");
    }

    const attemptId = created.r_attempt_id;
    const ref = created.r_merchant_txn_no;
    const paise = Number(created.r_amount_paise);

    const { data: profile } = await supabase.from("profiles").select("name, email, phone").eq("id", userId).maybeSingle();

    let init;
    try {
        init = await initiateSale({
            merchantTxnNo: ref, amountPaise: paise,
            email: profile?.email, mobile: profile?.phone, name: profile?.name,
        });
    } catch (e) {
        console.error("[payments] initiateSale failed:", ref, e?.code || "", e?.message || e);
        await supabase.from("payment_attempts")
            .update({ status: "failed", gateway_message: String(e?.message || "initiate failed").slice(0, 500), completed_at: new Date().toISOString() })
            .eq("id", attemptId).eq("status", "created");
        await supabase.from("payment_events").insert({
            attempt_id: attemptId, merchant_txn_no: ref, source: "initiate", hash_valid: null,
            response_code: e?.code || null, payload: { error: String(e?.message || "").slice(0, 300) },
        });
        throw new PaymentError(502, "The payment gateway isn't reachable right now. Please try again in a moment.", "GATEWAY_UNAVAILABLE");
    }

    await supabase.from("payment_attempts")
        .update({ status: "initiated", tran_ctx: init.tranCtx, redirect_uri: init.redirectUri })
        .eq("id", attemptId).eq("status", "created"); // never regress a status a fast webhook already advanced

    return { ref, redirectUrl: init.redirectUrl, amountPaise: paise };
}

/* ================================================================ core: apply */

async function processOutcome({ ref, source, outcome, code, message, gatewayTxnId, paymentMode, amountPaise, payload }) {
    const { data, error } = await supabase.rpc("payment_process_result", {
        p_merchant_txn_no: ref,
        p_source: source,
        p_outcome: outcome,
        p_response_code: code || null,
        p_message: message || null,
        p_gateway_txn_id: gatewayTxnId || null,
        p_payment_mode: paymentMode || null,
        p_amount_paise: amountPaise ?? null,
        p_payload: sanitizePayload(payload),
    });
    if (error) throw new Error(`payment_process_result failed for ${ref}: ${error.message}`);
    return data;
}

/* ============================================================ side effects */

async function runEffects(r) {
    if (!r || typeof r !== "object") return;

    if (r.outcome === "mismatch") {
        await alertAdmins("Payment amount mismatch", `Gateway reported ${inr(r.received_paise)} but ${inr(r.expected_paise)} was expected (attempt ${r.attempt_id}). Needs manual review.`);
        return;
    }
    if (r.outcome === "refund_queued") {
        await alertAdmins("Late/duplicate payment queued for refund", `${inr(r.amount_paise)} was paid for something that can no longer take it (attempt ${r.attempt_id}). A refund has been queued automatically.`);
        return;
    }
    if (r.outcome !== "applied") return;

    if (r.purpose === "wallet_topup") {
        await safely("wallet notify", async () => {
            await notifyUser(r.user_id, {
                type: "wallet_credited", title: "Credits added",
                body: `${inr(r.amount_paise)} has been added to your wallet.`, link: "/seller/wallet",
            });
            await notifyIfWalletJustBlocked({ sellerId: r.seller_id, sellerUserId: r.user_id });
        });
        return;
    }

    const ids = Array.isArray(r.order_ids) ? r.order_ids : [];
    const { data: orders } = ids.length
        ? await supabase.from("orders")
            .select("id, order_number, seller_id, seller:seller_profiles ( user_id )")
            .in("id", ids)
        : { data: [] };

    for (const o of orders || []) {
        const sellerUserId = o.seller?.user_id;
        if (!sellerUserId) continue;
        await safely("wallet block check", () => notifyIfWalletJustBlocked({ sellerId: o.seller_id, sellerUserId }));
        await safely("seller notify", async () => {
            await notifyUser(sellerUserId, {
                type: "order_placed", title: `New order: ${o.order_number}`,
                body: "Payment confirmed. Check your Sales Orders to confirm it.", link: `/seller/orders/${o.id}`,
            });
            await notifyUserOrdersChanged(sellerUserId);
        });
        await safely("seller whatsapp", async () => {
            const { data: p } = await supabase.from("profiles").select("name, phone").eq("id", sellerUserId).maybeSingle();
            if (!p?.phone) return;
            await sendOrderUpdateWhatsApp({
                to: p.phone, name: p.name,
                headline: `Payment confirmed for order #${o.order_number}.`,
                detail: "This order is now waiting for your confirmation.",
                footer: "Please confirm or reject it soon in Sales Orders so the buyer isn't kept waiting.",
            });
        });
    }

    await safely("buyer notify", async () => {
        await notifyUser(r.user_id, {
            type: "payment_success", title: "Payment received",
            body: `We received your payment of ${inr(r.amount_paise)}. The seller has been notified.`,
            link: ids.length === 1 ? `/orders/${ids[0]}` : "/orders",
        });
        await notifyUserOrdersChanged(r.user_id);
    });
}

/* ================================================================== webhook */

async function loadAttempt(ref) {
    const { data } = await supabase.from("payment_attempts")
        .select("id, merchant_txn_no, amount_paise, status, expires_at")
        .eq("merchant_txn_no", ref).maybeSingle();
    return data || null;
}

async function logRejected(payload, reason) {
    await safely("log rejected callback", async () => {
        const ref = String(payload?.merchantTxnNo || "").slice(0, 20) || null;
        const attempt = isValidRef(ref) ? await loadAttempt(ref) : null;
        await supabase.from("payment_events").insert({
            attempt_id: attempt?.id || null, merchant_txn_no: ref, source: "webhook", hash_valid: false,
            response_code: reason, payload: sanitizePayload(payload),
        });
    });
}

async function handleRefundWebhook(payload, ref) {
    const { data: refund } = await supabase.from("payment_refunds")
        .select("id, status, amount_paise").eq("merchant_txn_no", ref).maybeSingle();
    if (!refund) return { ok: true, ignored: "UNKNOWN_REFUND" };

    await safely("log refund callback", () => supabase.from("payment_events").insert({
        refund_id: refund.id, merchant_txn_no: ref, source: "refund", hash_valid: true,
        response_code: String(payload.responseCode || "").slice(0, 20), payload: sanitizePayload(payload),
    }));

    const n = normalizeGatewayPayload(payload);
    if (classifyCode(n.code) === "success" && refund.status !== "success") {
        if (n.amountPaise != null && n.amountPaise !== Number(refund.amount_paise)) {
            await alertAdmins("Refund callback amount mismatch", `Refund ${ref}: callback ${inr(n.amountPaise)} vs expected ${inr(refund.amount_paise)}.`);
            return { ok: true };
        }
        await supabase.rpc("payment_finish_refund", {
            p_refund_id: refund.id, p_result: "success", p_code: n.code, p_message: n.message,
            p_gateway_ref: n.gatewayTxnId, p_retry_minutes: 0,
        });
    }
    return { ok: true };
}

// Returns { rejected } (bad hash/merchant), { retry } (could not verify now — let the gateway retry),
// or { ok, effects }.
export async function handleWebhook(payload) {
    if (!verifyPayloadHash(payload)) {
        await logRejected(payload, "BAD_HASH");
        return { rejected: "BAD_HASH" };
    }
    if (String(payload.merchantId || "") !== cfg.merchantId) {
        await logRejected(payload, "WRONG_MERCHANT");
        return { rejected: "WRONG_MERCHANT" };
    }

    const ref = String(payload.merchantTxnNo || "");
    if (ref.startsWith("RFD")) return handleRefundWebhook(payload, ref);
    if (!isValidRef(ref)) return { ok: true, ignored: "UNKNOWN_REF" };

    const attempt = await loadAttempt(ref);
    if (!attempt) return { ok: true, ignored: "UNKNOWN_TXN" };

    const n = normalizeGatewayPayload(payload);
    let outcome = classifyCode(n.code);
    let amountPaise = n.amountPaise;

    if (outcome === "success" && cfg.confirmWebhookWithStatus) {
        let s;
        try {
            s = await statusCheck({ merchantTxnNo: ref, amountPaise: Number(attempt.amount_paise) });
        } catch (e) {
            console.error("[payments] could not confirm webhook via status API:", ref, e?.message || e);
            return { retry: true }; // do not apply on an unconfirmed success; the reconciler will resolve it
        }
        const confirmed = s.hashValid && classifyCode(s.code) === "success";
        if (!confirmed) {
            console.warn("[payments] webhook claimed success but the status API did not confirm:", ref, s.code);
            await alertAdmins("Webhook success not confirmed by status API", `Attempt ${ref}: webhook said success, status API said "${s.code || "unknown"}". Not applied; it will be re-checked automatically.`);
            outcome = "pending";
        } else if (s.amountPaise != null && n.amountPaise != null && s.amountPaise !== n.amountPaise) {
            amountPaise = null; // the two answers disagree -> force the mismatch path
        }
    }

    const result = await processOutcome({
        ref, source: "webhook", outcome, code: n.code, message: n.message,
        gatewayTxnId: n.gatewayTxnId, paymentMode: n.paymentMode, amountPaise, payload,
    });
    return { ok: true, result, effects: () => runEffects(result) };
}

// B2B browser return: log only. Never credit from here.
export async function logReturnEvent(ref, payload) {
    await safely("log return", async () => {
        const attempt = await loadAttempt(ref);
        if (!attempt) return;
        await supabase.from("payment_events").insert({
            attempt_id: attempt.id, merchant_txn_no: ref, source: "return",
            hash_valid: verifyPayloadHash(payload), response_code: String(payload?.responseCode || "").slice(0, 20),
            payload: sanitizePayload(payload),
        });
    });
}

/* ============================================================== reconciler */

export async function reconcileAttempt({ id, ref, amountPaise, status, expiresAt }) {
    let s;
    try {
        s = await statusCheck({ merchantTxnNo: ref, amountPaise });
    } catch (e) {
        console.error("[payments] status check failed:", ref, e?.code || "", e?.message || e);
        return null;
    }

    const expired = new Date(expiresAt).getTime() <= Date.now();
    let outcome = s.hashValid ? classifyCode(s.code) : "pending";
    // An explicit failure before the attempt expires is not final (the buyer may retry inside the same session).
    if (outcome === "failed" && !expired && status !== "expired") outcome = "pending";

    const amount = outcome === "success" ? (s.amountPaise ?? amountPaise) : (s.amountPaise ?? null);
    const result = await processOutcome({
        ref, source: "status_check", outcome, code: s.code, message: s.message,
        gatewayTxnId: s.gatewayTxnId, paymentMode: s.paymentMode, amountPaise: amount, payload: s.raw,
    });

    if (outcome === "pending" && expired && LIVE.includes(status)) {
        await supabase.rpc("payment_expire_attempt", { p_attempt_id: id });
    }
    await runEffects(result);
    return result;
}

async function inChunks(items, size, fn) {
    for (let i = 0; i < items.length; i += size) {
        await Promise.allSettled(items.slice(i, i + size).map(fn));
    }
}

export async function reconcileTick() {
    const { data: rows, error } = await supabase.rpc("payment_claim_for_reconcile", { p_limit: 25 });
    if (error) console.error("[payments] claim for reconcile failed:", error.message);
    await inChunks(rows || [], 5, (r) => reconcileAttempt({
        id: r.r_id, ref: r.r_merchant_txn_no, amountPaise: Number(r.r_amount_paise),
        status: r.r_status, expiresAt: r.r_expires_at,
    }).catch((e) => console.error("[payments] reconcile error:", r.r_merchant_txn_no, e?.message || e)));

    const { error: repairErr } = await supabase.rpc("payment_repair_commissions", { p_limit: 50 });
    if (repairErr) console.error("[payments] commission repair failed:", repairErr.message);

    await processRefundQueue();
}

/* ============================================================ buyer polling */

export async function getAttemptStatusForUser(ref, userId) {
    const cols = "id, merchant_txn_no, purpose, order_id, order_group_id, seller_id, amount_paise, status, apply_outcome, last_status_check_at, expires_at, created_at";
    const load = () => supabase.from("payment_attempts").select(cols).eq("merchant_txn_no", ref).eq("user_id", userId).maybeSingle();

    let { data: a } = await load();
    if (!a) return null;

    const now = Date.now();
    const stale = !a.last_status_check_at || now - new Date(a.last_status_check_at).getTime() > 5000;
    if ((LIVE.includes(a.status) || a.status === "expired") && stale && now - new Date(a.created_at).getTime() > 3000) {
        await supabase.from("payment_attempts").update({ last_status_check_at: new Date().toISOString() }).eq("id", a.id);
        await reconcileAttempt({
            id: a.id, ref: a.merchant_txn_no, amountPaise: Number(a.amount_paise), status: a.status, expiresAt: a.expires_at,
        }).catch((e) => console.error("[payments] on-demand reconcile failed:", ref, e?.message || e));
        ({ data: a } = await load());
    }

    let orderNumber = null;
    let groupNumber = null;
    if (a.order_id) {
        const { data } = await supabase.from("orders").select("order_number").eq("id", a.order_id).maybeSingle();
        orderNumber = data?.order_number || null;
    }
    if (a.order_group_id) {
        const { data } = await supabase.from("order_groups").select("group_number").eq("id", a.order_group_id).maybeSingle();
        groupNumber = data?.group_number || null;
    }

    let status;
    if (a.status === "success") status = a.apply_outcome === "applied" ? "success" : "refunded";
    else if (a.status === "needs_review") status = "review";
    else if (a.status === "failed") status = "failed";
    else if (a.status === "expired") status = "expired";
    else status = "pending";

    return {
        ref: a.merchant_txn_no,
        purpose: a.purpose,
        amount: Number(a.amount_paise) / 100,
        status,
        final: a.status === "success" || a.status === "failed" || a.status === "needs_review" || a.status === "expired",
        orderId: a.order_id,
        orderNumber,
        groupId: a.order_group_id,
        groupNumber,
    };
}

/* =================================================================== refunds */

export async function processRefundQueue() {
    const { error: enqErr } = await supabase.rpc("payment_enqueue_settlement_refunds", { p_limit: 50 });
    if (enqErr) console.error("[payments] enqueue settlement refunds failed:", enqErr.message);

    const { data: claimed, error } = await supabase.rpc("payment_claim_refunds", { p_limit: 20 });
    if (error) { console.error("[payments] claim refunds failed:", error.message); return; }
    await inChunks(claimed || [], 3, (r) => processOneRefund(r).catch((e) => console.error("[payments] refund error:", r.r_merchant_txn_no, e?.message || e)));
}

async function processOneRefund(r) {
    const id = r.r_id;
    const ref = r.r_merchant_txn_no;
    const paise = Number(r.r_amount_paise);
    const tries = Number(r.r_attempts);

    const finish = async (result, extra = {}) => {
        const { data: status } = await supabase.rpc("payment_finish_refund", {
            p_refund_id: id, p_result: result, p_code: extra.code ?? null, p_message: extra.message ?? null,
            p_gateway_ref: extra.gatewayRef ?? null, p_retry_minutes: extra.retryMinutes ?? 5,
        });
        if (status === "failed") {
            await alertAdmins("Refund failed", `Refund ${ref} for ${inr(paise)} could not be completed after ${tries} attempts. Check Payments -> Refunds.`);
        }
    };

    // On any retry, first ask the gateway whether the previous try already went through,
    // so a crash/timeout can never cause a double refund.
    if (tries > 1) {
        let s;
        try {
            s = await statusCheck({ merchantTxnNo: ref, amountPaise: paise });
        } catch (e) {
            return finish("retry", { message: `status pre-check failed: ${e?.message || e}`, retryMinutes: 10 });
        }
        if (!s.hashValid) return finish("retry", { code: s.code, message: "status pre-check unverifiable", retryMinutes: 15 });
        const c = classifyCode(s.code);
        if (c === "success") return finish("success", { code: s.code, message: s.message, gatewayRef: s.gatewayTxnId });
        if (c === "pending") return finish("retry", { code: s.code, message: s.message, retryMinutes: 10 });
    }

    let res;
    try {
        res = await issueRefund({ merchantTxnNo: ref, originalTxnNo: r.r_original_txn_no, amountPaise: paise });
    } catch (e) {
        return finish("retry", { message: `refund call failed: ${e?.message || e}`, retryMinutes: 5 });
    }

    await safely("log refund", () => supabase.from("payment_events").insert({
        refund_id: id, merchant_txn_no: ref, source: "refund_status", hash_valid: res.hashValid,
        response_code: res.code?.slice(0, 20) || null, payload: sanitizePayload(res.raw),
    }));

    const c = res.hashValid ? classifyCode(res.code) : "pending";
    if (c === "success") return finish("success", { code: res.code, message: res.message, gatewayRef: res.gatewayTxnId });
    if (c === "pending") return finish("retry", { code: res.code, message: res.message, retryMinutes: 5 });
    return finish("retry", { code: res.code, message: res.message, retryMinutes: Math.min(240, 5 * 2 ** Math.max(tries - 1, 0)) });
}