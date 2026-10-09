// src/controllers/payments.controller.js
import {
    createCheckout, handleWebhook, getAttemptStatusForUser, logReturnEvent, isValidRef, PaymentError,
} from "../services/payments.service.js";
import { amountToPaise } from "../services/jiopay.client.js";
import { jiopayConfig as cfg } from "../config/jiopay.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(res, e, label) {
    if (e instanceof PaymentError) {
        return res.status(e.status).json({ success: false, code: e.code, message: e.message });
    }
    console.error(`[payments] ${label} failed:`, e);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
}

/* ------------------------------------------------------------------ checkout */

// POST /api/payments/orders/:orderId/checkout  -> { ref, redirectUrl }
export async function checkoutOrder(req, res) {
    try {
        const { orderId } = req.params;
        if (!UUID_RE.test(orderId)) return res.status(400).json({ success: false, message: "Invalid order." });
        const out = await createCheckout({ purpose: "order", userId: req.user.id, targetId: orderId });
        res.json({ success: true, ref: out.ref, redirectUrl: out.redirectUrl });
    } catch (e) { fail(res, e, "checkoutOrder"); }
}

// POST /api/payments/groups/:groupId/checkout  -> { ref, redirectUrl }
export async function checkoutGroup(req, res) {
    try {
        const { groupId } = req.params;
        if (!UUID_RE.test(groupId)) return res.status(400).json({ success: false, message: "Invalid order." });
        const out = await createCheckout({ purpose: "order_group", userId: req.user.id, targetId: groupId });
        res.json({ success: true, ref: out.ref, redirectUrl: out.redirectUrl });
    } catch (e) { fail(res, e, "checkoutGroup"); }
}

// POST /api/payments/wallet/checkout  { amount }  (approved sellers only; req.sellerId set by middleware)
export async function checkoutWallet(req, res) {
    try {
        const amountPaise = amountToPaise(req.body?.amount);
        if (!amountPaise || amountPaise < 100 || amountPaise > 100000000) {
            return res.status(400).json({ success: false, message: "Enter a valid amount between ₹1 and ₹10,00,000." });
        }
        if (!req.sellerId) return res.status(403).json({ success: false, message: "Seller account not found." });
        const out = await createCheckout({ purpose: "wallet_topup", userId: req.user.id, targetId: req.sellerId, amountPaise });
        res.json({ success: true, ref: out.ref, redirectUrl: out.redirectUrl });
    } catch (e) { fail(res, e, "checkoutWallet"); }
}

/* ------------------------------------------------------------------- polling */

// GET /api/payments/attempts/:ref  (owner only)
export async function attemptStatus(req, res) {
    try {
        const { ref } = req.params;
        if (!isValidRef(ref)) return res.status(400).json({ success: false, message: "Invalid payment reference." });
        const view = await getAttemptStatusForUser(ref, req.user.id);
        if (!view) return res.status(404).json({ success: false, message: "Payment not found." });
        res.json({ success: true, payment: view });
    } catch (e) { fail(res, e, "attemptStatus"); }
}

/* -------------------------------------------------------------------- webhook */

const normalizeIp = (ip) => String(ip || "").replace(/^::ffff:/, "");

// POST /api/payments/jiopay/webhook  (public; authenticity = secureHash, optionally source IP)
export async function jiopayWebhook(req, res) {

    console.log("[payments] webhook hit:", req.method, normalizeIp(req.ip), req.headers["x-forwarded-for"] || "-", req.headers["content-type"], String(req.body?.merchantTxnNo || ""));
    try {
        if (cfg.webhookAllowedIps.length && !cfg.webhookAllowedIps.includes(normalizeIp(req.ip))) {
            console.warn("[payments] webhook from non-allowlisted IP:", normalizeIp(req.ip));
            return res.status(403).json({ success: false });
        }
        const payload = req.body;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return res.status(400).json({ success: false });
        }

        const out = await handleWebhook(payload);
        if (out.rejected) return res.status(400).json({ success: false });
        if (out.retry) return res.status(503).json({ success: false });

        res.status(200).json({ success: true });
        if (out.effects) out.effects().catch((e) => console.error("[payments] webhook effects failed:", e?.message || e));
    } catch (e) {
        console.error("[payments] webhook error:", e);
        if (!res.headersSent) res.status(500).json({ success: false });
    }
}

/* --------------------------------------------------------------- browser return */

// GET|POST /pay/return — JioPay sends the buyer's browser here (often as a form POST, which a
// static SPA page cannot receive). We only log it, then 303-redirect to the frontend page, which
// polls GET /api/payments/attempts/:ref. Nothing is credited from this request.
export async function payReturn(req, res) {
    if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();

    const src = { ...(req.query || {}), ...(req.body || {}) };
    const ref = String(src.merchantTxnNo || "");
    if (!isValidRef(ref)) return res.redirect(303, `${cfg.frontendUrl}/orders`);

    await logReturnEvent(ref, src);
    return res.redirect(303, `${cfg.frontendUrl}/payment/return?ref=${encodeURIComponent(ref)}`);
}