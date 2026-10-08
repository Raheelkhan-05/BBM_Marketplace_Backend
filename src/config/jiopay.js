// src/config/jiopay.js
//
// All JioPay settings come from environment variables. The secret key is read here and
// used ONLY by services/jiopay.client.js — never log it, never send it to the browser.
//
// Required (Render -> Environment):
//   JIOPAY_ENV              uat | prod            (default: uat)
//   JIOPAY_MERCHANT_ID      your MID
//   JIOPAY_SECRET_KEY       your secret key
//   JIOPAY_RETURN_URL       https://bbm-marketplace-backend.onrender.com/pay/return   (max 64 chars)
//   FRONTEND_URL            https://www.bbm.business
// Optional:
//   JIOPAY_BASE_URL         override gateway host (default: UAT https://uat.jiopay.co.in/tsp, PROD https://jiopay.co.in)
//   JIOPAY_AGGREGATOR_ID    only if JioPay told you to send one
//   JIOPAY_FALLBACK_EMAIL   used when a buyer has no email (default noreply@bbm.business)
//   JIOPAY_SUCCESS_CODES    comma list, default "0000"
//   JIOPAY_ATTEMPT_TTL_MINUTES        10-120, default 30
//   JIOPAY_CONFIRM_WEBHOOK_WITH_STATUS true|false, default true (re-verify every success via the status API)
//   JIOPAY_WEBHOOK_IPS      comma list of JioPay source IPs; when set, other IPs get 403
//   JIOPAY_HASH_DEBUG       true to log field NAMES (never values) when a hash does not verify

const flag = (v, fallback) =>
    v == null || v === "" ? fallback : ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const clamp = (n, min, max, fallback) => {
    const x = Number(n);
    return Number.isFinite(x) ? Math.min(Math.max(x, min), max) : fallback;
};

const isProd = String(process.env.JIOPAY_ENV || "uat").trim().toLowerCase() === "prod";

export const jiopayConfig = Object.freeze({
    isProd,
    merchantId: (process.env.JIOPAY_MERCHANT_ID || "").trim(),
    secretKey: (process.env.JIOPAY_SECRET_KEY || "").trim(),
    aggregatorId: (process.env.JIOPAY_AGGREGATOR_ID || "").trim(),
    baseUrl: (process.env.JIOPAY_BASE_URL || (isProd ? "https://jiopay.co.in" : "https://uat.jiopay.co.in/tsp"))
        .trim()
        .replace(/\/+$/, ""),
    returnUrl: (process.env.JIOPAY_RETURN_URL || "").trim(),
    frontendUrl: (process.env.FRONTEND_URL || "https://www.bbm.business").trim().replace(/\/+$/, ""),
    fallbackEmail: (process.env.JIOPAY_FALLBACK_EMAIL || "noreply@bbm.business").trim(),
    successCodes: new Set(list(process.env.JIOPAY_SUCCESS_CODES || "0000")),
    attemptTtlMinutes: clamp(process.env.JIOPAY_ATTEMPT_TTL_MINUTES, 10, 120, 30),
    confirmWebhookWithStatus: flag(process.env.JIOPAY_CONFIRM_WEBHOOK_WITH_STATUS, true),
    webhookAllowedIps: list(process.env.JIOPAY_WEBHOOK_IPS),
    requestTimeoutMs: clamp(process.env.JIOPAY_TIMEOUT_MS, 3000, 30000, 15000),
    hashDebug: flag(process.env.JIOPAY_HASH_DEBUG, false),
});

// Throws a clear error (surfaced as a 5xx to the caller, never to the buyer verbatim).
export function assertJiopayConfigured() {
    const c = jiopayConfig;
    const missing = [];
    if (!c.merchantId) missing.push("JIOPAY_MERCHANT_ID");
    if (!c.secretKey) missing.push("JIOPAY_SECRET_KEY");
    if (!c.returnUrl) missing.push("JIOPAY_RETURN_URL");
    if (missing.length) throw new Error(`JioPay is not configured: missing ${missing.join(", ")}`);
    if (!/^https:\/\//i.test(c.returnUrl)) throw new Error("JIOPAY_RETURN_URL must be an https URL");
    if (c.returnUrl.length > 64) throw new Error("JIOPAY_RETURN_URL must be at most 64 characters (JioPay limit)");
    if (c.isProd && /uat/i.test(c.baseUrl)) throw new Error("JIOPAY_ENV=prod but JIOPAY_BASE_URL points at UAT");
}

// Called once at startup so a bad deployment is obvious in the logs.
export function logJiopayConfigStatus() {
    try {
        assertJiopayConfigured();
        console.log(`[jiopay] configured (${jiopayConfig.isProd ? "PRODUCTION" : "UAT"}) base=${jiopayConfig.baseUrl}`);
        return true;
    } catch (e) {
        console.error(`[jiopay] ${e.message}`);
        return false;
    }
}