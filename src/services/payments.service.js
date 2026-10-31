// src/services/payments.service.js
//
// Orchestrates JioPay payments. Rules this file never breaks:
//   1. Money state changes ONLY through the SQL function payment_process_result() (atomic, idempotent).
//   2. "Paid" only ever comes from a hash-verified gateway response with a configured success code,
//      for the exact amount we stored server-side — and (by default) re-confirmed via the status API.
//   3. The browser return (B2B) never credits anything; it only triggers an authoritative status check.
//   4. Notifications are best-effort and run AFTER the database commit; they can never undo a payment.
//   5. A buyer who left mid-payment RESUMES the same gateway session (same reference, stored tranCtx)
//      while it is still valid, instead of opening a new one.
//   6. While the gateway/relay is blocked (circuit open) we make NO gateway calls: no new attempt rows,
//      no status checks, and refunds are not claimed (claiming burns their retry counter).
//   7. A gateway REJECTION (e.g. merchant limit breached) is reported as such, not as an outage.
import crypto from "crypto";
import { supabase } from "../config/supabase.js";
import { jiopayConfig as cfg, assertJiopayConfigured } from "../config/jiopay.js";
import {
    initiateSale, statusCheck, issueRefund, verifyPayloadHash, classifyCode,
    normalizeGatewayPayload, sanitizePayload, isGatewayBlocked, gatewayBlockedForSeconds,
} from "./jiopay.client.js";
import { notifyUser, notifyUserOrdersChanged } from "./realtimeBroadcast.js";
import { notifyAdmins } from "./notifications.service.js";
import { notifyIfWalletJustBlocked } from "./walletNotifications.service.js";
import { sendOrderUpdateWhatsApp } from "./whatsapp.service.js";
import { captureServerAnon } from "./analytics.service.js";

export class PaymentError extends Error {
    constructor(status, message, code, details = null) {
        super(message);
        this.name = "PaymentError";
        this.status = status;
        this.code = code || "PAYMENT_ERROR";
        this.details = details;
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

const BLOCK_REASON = {
    LISTING_UNAVAILABLE: "is no longer available from the seller",
    LISTING_EXPIRED: "is no longer available (the seller's offer has ended)",
    PACKAGING_CHANGED: "was repackaged by the seller, so this quantity no longer applies",
    BELOW_MOQ: "is now below the seller's minimum order quantity",
    OUT_OF_STOCK: "is out of stock",
    EXCEEDS_AVAILABLE_STOCK: "is now more than the seller has in stock",
};

const toPaise = (rupees) => Math.round((Number(rupees) || 0) * 100);

// Keep a resumed session only if it still has at least this long to live.
const RESUME_MIN_REMAINING_MS = 60 * 1000;

// Is the thing being paid for still waiting for payment? (Never send a buyer back to pay for a
// cancelled / already-paid order.)
async function targetStillUnpaid(purpose, targetId) {
    if (purpose === "order") {
        const { data } = await supabase.from("orders").select("status").eq("id", targetId).maybeSingle();
        return data?.status === "awaiting_payment";
    }
    const { data } = await supabase.from("orders")
        .select("id").eq("order_group_id", targetId).eq("status", "awaiting_payment").limit(1);
    return !!data?.length;
}

// Finds a payment session this buyer already opened for the SAME order / cart that can still be
// completed, and rebuilds its gateway URL from what we stored (redirect_uri + tranCtx).
// No call to JioPay is made. Returns null when there is nothing to resume.
// 3) findResumableAttempt: accept expectedPaise and only resume a session for exactly that amount
async function findResumableAttempt({ purpose, userId, targetId, expectedPaise = null }) {
    if (purpose !== "order" && purpose !== "order_group") return null;

    const targetCol = purpose === "order" ? "order_id" : "order_group_id";
    let query = supabase.from("payment_attempts")
        .select("id, merchant_txn_no, amount_paise, tran_ctx, redirect_uri, expires_at")
        .eq("purpose", purpose)
        .eq(targetCol, targetId)
        .eq("user_id", userId)
        .in("status", ["initiated", "pending"])
        .not("tran_ctx", "is", null)
        .not("redirect_uri", "is", null)
        .gt("expires_at", new Date(Date.now() + RESUME_MIN_REMAINING_MS).toISOString());
    if (expectedPaise != null) query = query.eq("amount_paise", expectedPaise);

    const { data: a, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) {
        console.error("[payments] resumable attempt lookup failed:", error.message);
        return null;
    }
    if (!a) return null;
    if (!(await targetStillUnpaid(purpose, targetId))) return null;

    try {
        const target = new URL(String(a.redirect_uri));
        if (target.protocol !== "https:") return null;
        target.searchParams.set("tranCtx", String(a.tran_ctx));
        console.log("[payments] resuming existing gateway session:", a.merchant_txn_no);
        return { ref: a.merchant_txn_no, redirectUrl: target.toString(), amountPaise: Number(a.amount_paise), resumed: true };
    } catch {
        return null;
    }
}

// Reprices the unpaid order / cart under a lock. Returns the amount (paise) the buyer will be charged.
// Throws PRICE_CHANGED if it differs from what the buyer last saw (expectedTotal, or the stored total
// when the client sent none), ORDER_UNAVAILABLE if something can no longer be bought.
async function repriceForPayment({ purpose, userId, targetId, expectedTotal }) {
    const { data, error } = await supabase.rpc("order_reprice_for_payment", {
        p_buyer_id: userId, p_purpose: purpose, p_target_id: targetId,
    });
    if (error) {
        const code = (error.message || "").trim();
        const mapped = CREATE_ERRORS[code];
        if (mapped) throw new PaymentError(mapped[0], mapped[1], code);
        console.error("[payments] order_reprice_for_payment failed:", error.message);
        throw new PaymentError(500, "Couldn't start the payment. Please try again.", "CREATE_FAILED");
    }

    const what = purpose === "order_group" ? "cart" : "order";

    if (data?.blocked) {
        const b = (data.blockers || [])[0] || {};
        const reason = BLOCK_REASON[b.code] || "can't be bought right now";
        throw new PaymentError(
            409,
            `${b.product_name || "An item"} ${reason}. This ${what} can't be paid right now. You can cancel it from My orders.`,
            "ORDER_UNAVAILABLE",
            { blockers: data.blockers }
        );
    }

    if (data?.changed) await safely("orders refresh", () => notifyUserOrdersChanged(userId));

    const currentPaise = toPaise(data.current_total);
    const hasExpected = expectedTotal != null && Number.isFinite(Number(expectedTotal));
    const expectedPaise = hasExpected ? toPaise(expectedTotal) : toPaise(data.previous_total);

    if (currentPaise !== expectedPaise) {
        const up = currentPaise > expectedPaise;
        throw new PaymentError(
            409,
            `The price changed: your ${what} was ${inr(expectedPaise)} and is now ${inr(currentPaise)} (${up ? "an increase" : "a decrease"}). Please check the new amount in My orders, then pay again.`,
            "PRICE_CHANGED",
            { previousTotal: expectedPaise / 100, currentTotal: currentPaise / 100, direction: up ? "up" : "down" }
        );
    }
    return currentPaise;
}

// purpose: 'order' | 'order_group' | 'wallet_topup'
// 4) createCheckout: reprice first; final guard after the attempt row is created
export async function createCheckout({ purpose, userId, targetId, amountPaise = null, expectedTotal = null }) {
    assertJiopayConfigured();

    let expectedPaise = null;
    if (purpose === "order" || purpose === "order_group") {
        expectedPaise = await repriceForPayment({ purpose, userId, targetId, expectedTotal });
    }

    const resumable = await findResumableAttempt({ purpose, userId, targetId, expectedPaise });
    if (resumable) return resumable;

    if (isGatewayBlocked()) {
        console.warn(`[payments] checkout refused: gateway paused for another ${gatewayBlockedForSeconds()}s`);
        throw new PaymentError(503, "Payments are temporarily unavailable. Please try again in a few minutes.", "GATEWAY_UNAVAILABLE");
    }

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

    // Someone changed the price between our reprice and this row (e.g. another tab): never charge an unseen amount.
    if (expectedPaise != null && paise !== expectedPaise) {
        await supabase.from("payment_attempts")
            .update({ status: "failed", gateway_message: "price changed during checkout", completed_at: new Date().toISOString() })
            .eq("id", attemptId).eq("status", "created");
        throw new PaymentError(409, "The price of this order just changed. Please review it and try again.", "PRICE_CHANGED",
            { previousTotal: expectedPaise / 100, currentTotal: paise / 100, direction: paise > expectedPaise ? "up" : "down" });
    }

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
            .update({
                status: "failed", gateway_response_code: e?.gatewayCode || null,
                gateway_message: String(e?.gatewayMessage || e?.message || "initiate failed").slice(0, 500),
                completed_at: new Date().toISOString(),
            })
            .eq("id", attemptId).eq("status", "created");
        await supabase.from("payment_events").insert({
            attempt_id: attemptId, merchant_txn_no: ref, source: "initiate", hash_valid: null,
            response_code: e?.gatewayCode || e?.code || null,
            payload: { error: String(e?.gatewayMessage || e?.message || "").slice(0, 300) },
        });

        // The gateway ANSWERED and said no (e.g. "Limit breached"): that is not an outage.
        if (e?.code === "INITIATE_REJECTED") {
            const limitHit = /limit/i.test(e.gatewayMessage || "");
            await alertAdmins(
                limitHit ? "JioPay merchant limit reached" : "JioPay rejected a payment request",
                `Attempt ${ref} for ${inr(paise)} was rejected by JioPay: ${e.gatewayCode || ""} ${e.gatewayMessage || ""}. ${limitHit ? "Ask JioPay to raise the transaction / daily limits on this merchant account." : "Check the merchant configuration."}`
            );
            throw new PaymentError(
                422,
                limitHit
                    ? "This payment is above the amount our payment gateway currently allows. Please contact support, or try again later."
                    : "The payment gateway couldn't accept this payment. Please contact support.",
                "GATEWAY_REJECTED"
            );
        }
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

    // Analytics (anonymous, never tied to a person): the authoritative payment outcomes.
    if (r.outcome === "applied") {
        captureServerAnon("payment_succeeded", {
            purpose: r.purpose || null,
            amount_inr: (Number(r.amount_paise) || 0) / 100,
            order_count: Array.isArray(r.order_ids) ? r.order_ids.length : 0,
        });
    } else if (r.outcome === "mismatch") {
        captureServerAnon("payment_mismatch", {});
    } else if (r.outcome === "refund_queued") {
        captureServerAnon("payment_refund_queued", { amount_inr: (Number(r.amount_paise) || 0) / 100 });
    }

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
                body: `${inr(r.amount_paise)} has been added to your wallet.`, link: "/sell/wallet",
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
                body: "Payment confirmed. Check your Sales Orders to confirm it.", link: `/sell/orders/${o.id}`,
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
            link: ids.length === 1 ? `/buy/orders/${ids[0]}` : "/buy/orders",
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

/* ------------------------------------------------------- refund notifications */

// Who should hear about a refund: the person who made the original payment.
async function loadRefundParties(refundId) {
    const { data: refund } = await supabase.from("payment_refunds")
        .select("id, attempt_id, order_id, amount_paise, merchant_txn_no").eq("id", refundId).maybeSingle();
    if (!refund) return null;
    let userId = null;
    let purpose = null;
    if (refund.attempt_id) {
        const { data: a } = await supabase.from("payment_attempts")
            .select("user_id, purpose").eq("id", refund.attempt_id).maybeSingle();
        userId = a?.user_id || null;
        purpose = a?.purpose || null;
    }
    let orderNumber = null;
    if (refund.order_id) {
        const { data: o } = await supabase.from("orders").select("order_number").eq("id", refund.order_id).maybeSingle();
        orderNumber = o?.order_number || null;
    }
    return { refund, userId, purpose, orderNumber };
}

// kind: 'initiated' | 'success' | 'delayed'
async function notifyRefund(refundId, kind) {
    await safely(`refund notify (${kind})`, async () => {
        const ctx = await loadRefundParties(refundId);
        if (!ctx?.userId) return;
        const amount = inr(ctx.refund.amount_paise);
        const forOrder = ctx.orderNumber ? ` for order ${ctx.orderNumber}` : "";
        const link = ctx.purpose === "wallet_topup" ? "/seller/wallet" : ctx.refund.order_id ? `/orders/${ctx.refund.order_id}` : "/orders";

        const copy = {
            initiated: {
                type: "refund_initiated", title: "Refund initiated",
                body: `Your refund of ${amount}${forOrder} has been started. It goes back to your original payment method and can take 5–7 working days to show up.`,
            },
            success: {
                type: "refund_success", title: "Refund processed",
                body: `Your refund of ${amount}${forOrder} has been sent to your original payment method. Your bank may take a few working days to show it.`,
            },
            delayed: {
                type: "refund_delayed", title: "Refund is taking longer than usual",
                body: `We're having trouble sending your refund of ${amount}${forOrder}. Our team has been alerted and will complete it manually — you don't need to do anything.`,
            },
        }[kind];

        await notifyUser(ctx.userId, { ...copy, link });
        await notifyUserOrdersChanged(ctx.userId);
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
        const { data: status } = await supabase.rpc("payment_finish_refund", {
            p_refund_id: refund.id, p_result: "success", p_code: n.code, p_message: n.message,
            p_gateway_ref: n.gatewayTxnId, p_retry_minutes: 0,
        });
        if (status === "success") await notifyRefund(refund.id, "success");
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
            return { retry: true }; // do not apply on an unconfirmed success; the gateway will retry the webhook
        }
        const confirmed = s.hashValid && classifyCode(s.code) === "success" && s.txnStatus === "SUC";
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

export async function reconcileAttempt({ id, ref, amountPaise, status, expiresAt, buyerReturned = false }) {
    let s;
    try {
        s = await statusCheck({ merchantTxnNo: ref, amountPaise });
    } catch (e) {
        // While the gateway is paused every call fails by design; the pause itself was logged once.
        if (e?.code !== "GATEWAY_BLOCKED") console.error("[payments] status check failed:", ref, e?.code || "", e?.message || e);
        return null;
    }

    const expired = new Date(expiresAt).getTime() <= Date.now();
    let outcome = s.hashValid ? classifyCode(s.code) : "pending";

    if (!s.hashValid) console.warn("[payments] status response hash NOT verified:", ref, s.code);
    if (outcome === "success" && s.txnStatus !== "SUC") {
        console.warn("[payments] code says success but txnStatus is", s.txnStatus, ref);
        outcome = "pending";
    }

    // Only an explicit rejection (REJ) counts as final before expiry. Anything else stays provisional.
    const explicitReject = s.txnStatus === "REJ";
    if (outcome === "failed" && !expired && status !== "expired" && !explicitReject && !buyerReturned) {
        outcome = "pending";
    }

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
    // Gateway paused: skip the status checks (claiming rows would only mark them as "checked").
    if (!isGatewayBlocked()) {
        const { data: rows, error } = await supabase.rpc("payment_claim_for_reconcile", { p_limit: 25 });
        if (error) console.error("[payments] claim for reconcile failed:", error.message);
        await inChunks(rows || [], 5, (r) => reconcileAttempt({
            id: r.r_id, ref: r.r_merchant_txn_no, amountPaise: Number(r.r_amount_paise),
            status: r.r_status, expiresAt: r.r_expires_at,
        }).catch((e) => console.error("[payments] reconcile error:", r.r_merchant_txn_no, e?.message || e)));
    }

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
    if (!isGatewayBlocked() && (LIVE.includes(a.status) || a.status === "expired") && stale && now - new Date(a.created_at).getTime() > 3000) {
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
    const { error: cancelErr } = await supabase.rpc("payment_enqueue_cancel_refunds", { p_limit: 50 });
    if (cancelErr) console.error("[payments] enqueue cancel refunds failed:", cancelErr.message);

    const { error: enqErr } = await supabase.rpc("payment_enqueue_settlement_refunds", { p_limit: 50 });
    if (enqErr) console.error("[payments] enqueue settlement refunds failed:", enqErr.message);

    // Queuing above is database-only and always safe. Claiming a refund counts as one attempt, so while
    // the gateway is paused we leave them queued instead of using up their retries on calls that cannot succeed.
    if (isGatewayBlocked()) return;

    const { data: claimed, error } = await supabase.rpc("payment_claim_refunds", { p_limit: 20 });
    if (error) { console.error("[payments] claim refunds failed:", error.message); return; }
    await inChunks(claimed || [], 3, (r) => processOneRefund(r).catch((e) => console.error("[payments] refund error:", r.r_merchant_txn_no, e?.message || e)));
}

// Re-submitting a declined refund under a NEW reference is OFF by default: while the gateway is declining
// every refund for an environmental reason (e.g. UAT), it only piles up extra declined references.
// Turn it on (JIOPAY_REFUND_RESUBMIT=true) once refunds work and you want declines retried automatically.
const RESUBMIT_DECLINED = ["1", "true", "yes", "on"].includes(String(process.env.JIOPAY_REFUND_RESUBMIT || "").trim().toLowerCase());

// A fresh reference for re-submitting a refund the gateway has DEFINITELY declined.
// Same shape as the originals: "RFD" + 17 upper-case hex chars.
const newRefundRef = () => `RFD${crypto.randomBytes(9).toString("hex").slice(0, 17).toUpperCase()}`;

async function processOneRefund(r) {
    const id = r.r_id;
    let ref = r.r_merchant_txn_no;
    const paise = Number(r.r_amount_paise);
    const tries = Number(r.r_attempts);

    const finish = async (result, extra = {}) => {
        const { data: status } = await supabase.rpc("payment_finish_refund", {
            p_refund_id: id, p_result: result, p_code: extra.code ?? null, p_message: extra.message ?? null,
            p_gateway_ref: extra.gatewayRef ?? null, p_retry_minutes: extra.retryMinutes ?? 5,
        });
        if (status === "success") {
            await notifyRefund(id, "success");
        } else if (status === "failed") {
            await alertAdmins("Refund failed", `Refund ${ref} for ${inr(paise)} could not be completed after ${tries} attempts (last gateway answer: ${extra.code || "n/a"} ${extra.message || ""}). Check Payments -> Refunds.`);
            await notifyRefund(id, "delayed");
        }
        return status;
    };

    // The buyer hears about it as soon as we first submit the refund — not only when it finishes.
    if (tries <= 1) await notifyRefund(id, "initiated");

    // On any retry, first ask the gateway what happened to the previous try, so a crash/timeout
    // can never cause a double refund.
    if (tries > 1) {
        let s;
        try {
            s = await statusCheck({ merchantTxnNo: ref, amountPaise: paise });
        } catch (e) {
            return finish("retry", { message: `status pre-check failed: ${e?.message || e}`, retryMinutes: 10 });
        }
        await safely("log refund pre-check", () => supabase.from("payment_events").insert({
            refund_id: id, merchant_txn_no: ref, source: "refund_status", hash_valid: s.hashValid,
            response_code: s.code?.slice(0, 20) || null, payload: sanitizePayload(s.raw),
        }));
        if (!s.hashValid) return finish("retry", { code: s.code, message: "status pre-check unverifiable", retryMinutes: 15 });

        const cls = classifyCode(s.code);
        if (cls === "success" && s.txnStatus === "SUC") {
            return finish("success", { code: s.code, message: s.message, gatewayRef: s.gatewayTxnId });
        }
        if (cls === "pending") {
            return finish("retry", { code: s.code, message: s.message, retryMinutes: 10 });
        }

        // The gateway has given a verified, final "no" for THIS reference (e.g. 039 Transaction Declined).
        // Polling it again can never change the answer, which is why these used to sit in "queued" forever.
        // It is safe to re-submit under a NEW reference: the old one was declined, so no money moved.
        if (!RESUBMIT_DECLINED || s.txnStatus === "SUC") {
            return finish("retry", { code: s.code, message: s.message, retryMinutes: Math.min(240, 10 * 2 ** Math.max(tries - 2, 0)) });
        }
        {
            const fresh = newRefundRef();
            const { error: swapErr } = await supabase.from("payment_refunds")
                .update({ merchant_txn_no: fresh }).eq("id", id).eq("merchant_txn_no", ref);
            if (swapErr) {
                console.error("[payments] couldn't assign a new refund reference:", ref, swapErr.message);
                return finish("retry", { code: s.code, message: s.message, retryMinutes: 30 });
            }
            console.warn(`[payments] refund ${ref} declined (${s.code} ${s.message}); re-submitting as ${fresh}`);
            ref = fresh;
            // fall through to a fresh submit below
        }
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

    // Declined on submit. Tell the admins ONCE, with the gateway's own words, so the real cause gets fixed
    // instead of the refund silently retrying until it gives up.
    if (tries <= 1) {
        await alertAdmins(
            "Refund declined by JioPay",
            `Refund ${ref} for ${inr(paise)} (original ${r.r_original_txn_no}) was declined: ${res.code} ${res.message || ""}. It will keep retrying with backoff; ask JioPay why if it persists.`,
        );
    }
    return finish("retry", { code: res.code, message: res.message, retryMinutes: Math.min(240, 5 * 2 ** Math.max(tries - 1, 0)) });
}