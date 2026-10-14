// src/services/jiopay.client.js
//
// Thin, dependency-free client for JioPay (Jio Payment Solutions Ltd) hosted checkout.
// Hash algorithm (docs.jiopay.in/docs/generate-hash): sort the keys alphabetically,
// concatenate the VALUES with no delimiter, HMAC-SHA256 with the merchant secret, lowercase hex.
//
// Static-IP relay: when JIOPAY_BASE_URL points at our VPS relay, every call carries an
// X-Relay-Key header (JIOPAY_RELAY_KEY). The relay forwards the request body untouched, so hashes
// still verify exactly as before. The relay only serves paths under /prod or /uat, so the base URL
// must be e.g. https://relay.bbm.business/prod.
//
// Circuit breaker: when the relay / gateway answers with something that is not JSON and looks like a
// configuration block (HTTP 401/403/404), further calls fail instantly for a cooldown instead of
// hammering a door that is shut. Transient failures (timeouts, 5xx) open it after 3 in a row.
// Any JSON answer from the gateway closes it again.
//
// UAT evidence: set JIOPAY_LOG_API_CALLS=true to store every request we send and every response we get
// in the payment_api_logs table (see sql/payment_api_logs.sql). Off by default: it stores customer
// email/mobile, so switch it off again once sign-off is done. The secret key is never part of a request body.
import crypto from "crypto";
import { jiopayConfig as cfg, assertJiopayConfigured } from "../config/jiopay.js";
import { supabase } from "../config/supabase.js";

export class JiopayError extends Error {
    constructor(code, message, { retryable = false, gatewayCode = null, gatewayMessage = null } = {}) {
        super(message);
        this.name = "JiopayError";
        this.code = code;
        this.retryable = retryable;
        this.gatewayCode = gatewayCode;       // JioPay's own response code, e.g. "P1006"
        this.gatewayMessage = gatewayMessage; // JioPay's own description, e.g. "Limit breached: ..."
    }
}

const LOG_API_CALLS = ["1", "true", "yes", "on"].includes(String(process.env.JIOPAY_LOG_API_CALLS || "").trim().toLowerCase());

/* ----------------------------------------------------------- circuit breaker */

const clampNum = (n, min, max, fallback) => {
    const x = Number(n);
    return Number.isFinite(x) ? Math.min(Math.max(x, min), max) : fallback;
};
// How long calls are refused after a configuration-type block (401/403/404).
const BLOCK_COOLDOWN_MS = clampNum(process.env.JIOPAY_BLOCK_COOLDOWN_SECONDS, 10, 900, 120) * 1000;
// How long calls are refused after repeated transient failures.
const TRANSIENT_COOLDOWN_MS = 30 * 1000;
const TRANSIENT_THRESHOLD = 3;

let blockedUntil = 0;
let transientFailures = 0;

export function isGatewayBlocked() {
    return Date.now() < blockedUntil;
}

export function gatewayBlockedForSeconds() {
    return Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000));
}

function openCircuit(ms, reason) {
    const wasClosed = !isGatewayBlocked();
    blockedUntil = Date.now() + ms;
    if (wasClosed) {
        console.error(`[jiopay] gateway calls paused for ${Math.round(ms / 1000)}s: ${reason}. Run "node --env-file=.env scripts/jiopay-probe.js" to diagnose.`);
    }
}

function noteFailure(httpStatus, reason) {
    if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) {
        transientFailures = 0;
        openCircuit(BLOCK_COOLDOWN_MS, reason);
        return;
    }
    transientFailures += 1;
    if (transientFailures >= TRANSIENT_THRESHOLD) {
        transientFailures = 0;
        openCircuit(TRANSIENT_COOLDOWN_MS, reason);
    }
}

function noteGatewayAnswered() {
    transientFailures = 0;
    if (blockedUntil) {
        if (isGatewayBlocked()) console.log("[jiopay] gateway answered again; resuming calls");
        blockedUntil = 0;
    }
}

/* ------------------------------------------------------------------ logging */

// Fire-and-forget: a logging problem must never affect a payment.
function logApiCall({ path, request, httpStatus = null, response = null, error = null }) {
    if (!LOG_API_CALLS) return;
    const api = path.includes("initiateSale") ? "initiateSale" : String(request?.transactionType || "command");
    (async () => {
        try {
            const { error: dbErr } = await supabase.from("payment_api_logs").insert({
                api,
                merchant_txn_no: request?.merchantTxnNo ? String(request.merchantTxnNo).slice(0, 40) : null,
                request,
                http_status: httpStatus,
                response,
                error,
            });
            if (dbErr) console.error("[jiopay] api log insert failed:", dbErr.message);
        } catch (e) {
            console.error("[jiopay] api log insert failed:", e?.message || e);
        }
    })();
}

/* ------------------------------------------------------------------ money */

// "123.45" / "123" -> paise (integer). Returns null for anything that is not a plain amount.
export function amountToPaise(value) {
    const s = String(value ?? "").trim();
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
    const [rupees, frac = ""] = s.split(".");
    return Number(rupees) * 100 + Number((frac + "00").slice(0, 2));
}

export function paiseToAmountString(paise) {
    const p = Math.round(Number(paise));
    if (!Number.isSafeInteger(p) || p < 0) throw new JiopayError("BAD_AMOUNT", "Invalid amount");
    return `${Math.floor(p / 100)}.${String(p % 100).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------- hash */

function messageString(fields) {
    return Object.keys(fields)
        .sort()
        .map((k) => {
            const v = fields[k];
            return v === null || v === undefined || typeof v === "object" ? "" : String(v);
        })
        .join("");
}

export function computeHash(fields) {
    return crypto.createHmac("sha256", cfg.secretKey).update(messageString(fields), "utf8").digest("hex");
}

// Constant-time verification of a payload that carries `secureHash`.
// Fields JioPay returns but does not include in the command-response hash.
const COMMAND_HASH_EXCLUDE = new Set(["oth_charge"]);

export function verifyPayloadHash(payload, { exclude = null } = {}) {
    if (!payload || typeof payload !== "object") return false;
    const received = String(payload.secureHash || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(received)) return false;
    // eslint-disable-next-line no-unused-vars
    const { secureHash, ...rest } = payload;
    const body = exclude
        ? Object.fromEntries(Object.entries(rest).filter(([k]) => !exclude.has(k)))
        : rest;
    const expected = Buffer.from(computeHash(body), "hex");
    const actual = Buffer.from(received, "hex");
    const ok = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!ok && cfg.hashDebug) {
        console.warn("[jiopay] secureHash did not verify. Fields present:", Object.keys(body).sort().join(","));
    }
    return ok;
}

/* ---------------------------------------------------------------- helpers */

// Hash input must match what JioPay hashes; keep request text plain ASCII.
const ascii = (s, max) =>
    String(s ?? "").normalize("NFKD").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

// YYYYMMDDHHMMSS in IST (the gateway is Indian).
function txnDate(d = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t).value;
    const hh = get("hour") === "24" ? "00" : get("hour");
    return `${get("year")}${get("month")}${get("day")}${hh}${get("minute")}${get("second")}`;
}

// Short, single-line, safe-to-log version of a non-JSON body (HTML error pages, WAF blocks, relay errors).
const bodySnippet = (text) => String(text || "").replace(/\s+/g, " ").trim().slice(0, 300);

// JioPay's description field is "responseDescription" (older docs / some payloads use "respDescription").
const gatewayDescription = (data) =>
    String(data?.responseDescription ?? data?.respDescription ?? data?.message ?? "").trim().slice(0, 300);

// A plain-English guess at who blocked the request, for the server log only.
function hintForStatus(status) {
    if (status === 401 || status === 403) {
        return cfg.relayKey
            ? "Blocked before reaching JioPay's API. Check: JIOPAY_RELAY_KEY matches the relay's Caddyfile key, JIOPAY_BASE_URL ends in /prod or /uat, and the relay's public IP is whitelisted at JioPay for this environment."
            : "Blocked before reaching JioPay's API and no relay key is configured (relay=off). Calls leave from this machine's IP, which JioPay does not allow. Set JIOPAY_BASE_URL (relay) and JIOPAY_RELAY_KEY.";
    }
    if (status === 404) return "Path not found. Check JIOPAY_BASE_URL (relay: https://relay.bbm.business/prod or /uat; direct UAT must include /tsp; direct production has no prefix).";
    if (status >= 500) return "The relay or JioPay returned a server error / is unreachable.";
    return "Unexpected non-JSON answer.";
}

async function post(path, { json, form }) {
    assertJiopayConfigured();

    if (isGatewayBlocked()) {
        throw new JiopayError(
            "GATEWAY_BLOCKED",
            `Gateway calls are paused for another ${gatewayBlockedForSeconds()}s after repeated blocked responses`,
            { retryable: true }
        );
    }

    const url = `${cfg.baseUrl}${path}`;
    const request = json || form;

    const headers = json
        ? { "content-type": "application/json", accept: "application/json" }
        : { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    // Authenticates us to the static-IP relay (the relay strips it before forwarding to JioPay).
    if (cfg.relayKey) headers["x-relay-key"] = cfg.relayKey;

    let res;
    try {
        res = await fetch(url, {
            method: "POST",
            headers,
            body: json ? JSON.stringify(json) : new URLSearchParams(form).toString(),
            signal: AbortSignal.timeout(cfg.requestTimeoutMs),
        });
    } catch (e) {
        logApiCall({ path, request, error: String(e?.name || "error") });
        noteFailure(null, `network error (${e?.name || "error"})`);
        throw new JiopayError("NETWORK", `Gateway request failed: ${e?.name || "error"}`, { retryable: true });
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* handled below */ }
    logApiCall({ path, request, httpStatus: res.status, response: data ?? { nonJsonBody: text.slice(0, 500) } });
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        // Diagnostics: who answered, and what did they say? (No secrets: only host+path, status, headers and body text.)
        console.error(
            `[jiopay] non-JSON response from ${new URL(url).host}${path} -> HTTP ${res.status}`,
            `| relay=${cfg.relayKey ? "on" : "off"}`,
            `| server=${res.headers.get("server") || "-"} via=${res.headers.get("via") || "-"} content-type=${res.headers.get("content-type") || "-"}`,
            `| body="${bodySnippet(text) || "(empty)"}"`,
            `| hint: ${hintForStatus(res.status)}`
        );
        noteFailure(res.status, `non-JSON answer, HTTP ${res.status}`);
        throw new JiopayError("INVALID_RESPONSE", `Gateway returned a non-JSON response (HTTP ${res.status})`, { retryable: res.status >= 500 });
    }
    noteGatewayAnswered();
    return { httpStatus: res.status, data };
}

// Normalises a webhook / status / refund payload into one shape.
export function normalizeGatewayPayload(data) {
    const code = String(data.txnResponseCode ?? data.responseCode ?? "").trim();
    return {
        code,
        message: gatewayDescription(data).slice(0, 500),
        amountPaise: amountToPaise(data.amount),
        gatewayTxnId: data.txnID ? String(data.txnID) : data.paymentID ? String(data.paymentID) : null,
        txnStatus: data.txnStatus ? String(data.txnStatus) : null,
        paymentMode: data.paymentMode ? String(data.paymentMode).slice(0, 40) : null,
        merchantTxnNo: data.merchantTxnNo ? String(data.merchantTxnNo) : null,
        raw: data,
    };
}

// success | pending | failed.  Only a hash-verified, configured success code ever means "paid".
export function classifyCode(code) {
    const c = String(code || "").trim();
    if (cfg.successCodes.has(c)) return "success";
    if (!c || /^P/i.test(c) || c === "R1000") return "pending";
    return "failed";
}

// Never persist anything card-related, and cap value sizes.
export function sanitizePayload(p) {
    if (!p || typeof p !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(p)) {
        if (/^(cardNo|cvv|nameOnCard|cardExpiry|tokenCryptogram)$/i.test(k)) continue;
        out[k] = typeof v === "string" ? v.slice(0, 300) : v;
    }
    return out;
}

/* ---------------------------------------------------------------- API calls */

export async function initiateSale({ merchantTxnNo, amountPaise, email, mobile, name }) {
    const body = {
        merchantId: cfg.merchantId,
        merchantTxnNo,
        amount: paiseToAmountString(amountPaise),
        currencyCode: "356",
        payType: "0", // 0 = JioPay hosted checkout
        transactionType: "SALE",
        customerEmailID: ascii(email, 48) || cfg.fallbackEmail,
        returnURL: cfg.returnUrl,
        txnDate: txnDate(),
    };
    if (cfg.aggregatorId) body.aggregatorID = cfg.aggregatorId;
    const digits = String(mobile ?? "").replace(/\D/g, "").slice(-15);
    if (digits.length >= 8) body.customerMobileNo = digits;
    const cleanName = ascii(name, 45);
    if (cleanName) body.customerName = cleanName;
    body.secureHash = computeHash(body);

    const { data } = await post("/pg/api/v2/initiateSale", { json: body });

    if (!verifyPayloadHash(data)) throw new JiopayError("BAD_RESPONSE_HASH", "initiateSale response failed hash verification");
    if (String(data.responseCode) !== "R1000") {
        const gatewayMessage = gatewayDescription(data);
        throw new JiopayError(
            "INITIATE_REJECTED",
            `initiateSale rejected: ${data.responseCode} ${gatewayMessage}`.trim(),
            { gatewayCode: String(data.responseCode ?? ""), gatewayMessage }
        );
    }
    if (String(data.merchantTxnNo) !== merchantTxnNo) throw new JiopayError("TXN_MISMATCH", "initiateSale returned a different transaction number");
    if (!data.redirectURI || !data.tranCtx) throw new JiopayError("INVALID_RESPONSE", "initiateSale response is missing redirectURI / tranCtx");

    let target;
    try { target = new URL(String(data.redirectURI)); } catch { throw new JiopayError("INVALID_RESPONSE", "redirectURI is not a valid URL"); }
    if (target.protocol !== "https:") throw new JiopayError("INVALID_RESPONSE", "redirectURI is not https");
    target.searchParams.set("tranCtx", String(data.tranCtx));

    return { tranCtx: String(data.tranCtx), redirectUri: String(data.redirectURI), redirectUrl: target.toString() };
}

async function command(fields) {
    const withHash = { ...fields };
    if (cfg.aggregatorId) withHash.aggregatorID = cfg.aggregatorId;
    withHash.secureHash = computeHash(withHash);
    const { data } = await post("/pg/api/command", { form: withHash });
    const hashValid = verifyPayloadHash(data, { exclude: COMMAND_HASH_EXCLUDE });
    const normalized = normalizeGatewayPayload(data);
    if (normalized.merchantTxnNo && normalized.merchantTxnNo !== fields.merchantTxnNo) {
        throw new JiopayError("TXN_MISMATCH", "Gateway answered for a different transaction number");
    }
    return { ...normalized, hashValid };
}

// Status of a sale (or of a refund: pass the refund's own reference).
export function statusCheck({ merchantTxnNo, amountPaise }) {
    return command({
        merchantId: cfg.merchantId,
        merchantTxnNo,
        originalTxnNo: merchantTxnNo, // docs: same as originalTxnNo for STATUS
        amount: paiseToAmountString(amountPaise),
        transactionType: "STATUS",
    });
}

export function issueRefund({ merchantTxnNo, originalTxnNo, amountPaise }) {
    return command({
        merchantId: cfg.merchantId,
        merchantTxnNo, // the NEW reference for this refund
        originalTxnNo, // the sale being refunded
        amount: paiseToAmountString(amountPaise),
        transactionType: "REFUND",
    });
}