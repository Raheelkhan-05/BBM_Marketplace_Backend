// src/services/jiopay.client.js
//
// Thin, dependency-free client for JioPay (Jio Payment Solutions Ltd) hosted checkout.
// Hash algorithm (docs.jiopay.in/docs/generate-hash): sort the keys alphabetically,
// concatenate the VALUES with no delimiter, HMAC-SHA256 with the merchant secret, lowercase hex.
import crypto from "crypto";
import { jiopayConfig as cfg, assertJiopayConfigured } from "../config/jiopay.js";

export class JiopayError extends Error {
    constructor(code, message, { retryable = false } = {}) {
        super(message);
        this.name = "JiopayError";
        this.code = code;
        this.retryable = retryable;
    }
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
export function verifyPayloadHash(payload) {
    if (!payload || typeof payload !== "object") return false;
    const received = String(payload.secureHash || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(received)) return false;
    // eslint-disable-next-line no-unused-vars
    const { secureHash, ...rest } = payload;
    const expected = Buffer.from(computeHash(rest), "hex");
    const actual = Buffer.from(received, "hex");
    const ok = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!ok && cfg.hashDebug) {
        console.warn("[jiopay] secureHash did not verify. Fields present:", Object.keys(rest).sort().join(","));
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

async function post(path, { json, form }) {
    assertJiopayConfigured();
    const url = `${cfg.baseUrl}${path}`;
    let res;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: json
                ? { "content-type": "application/json", accept: "application/json" }
                : { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: json ? JSON.stringify(json) : new URLSearchParams(form).toString(),
            signal: AbortSignal.timeout(cfg.requestTimeoutMs),
        });
    } catch (e) {
        throw new JiopayError("NETWORK", `Gateway request failed: ${e?.name || "error"}`, { retryable: true });
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* handled below */ }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new JiopayError("INVALID_RESPONSE", `Gateway returned a non-JSON response (HTTP ${res.status})`, { retryable: res.status >= 500 });
    }
    return { httpStatus: res.status, data };
}

// Normalises a webhook / status / refund payload into one shape.
export function normalizeGatewayPayload(data) {
    const code = String(data.txnResponseCode ?? data.responseCode ?? "").trim();
    return {
        code,
        message: String(data.respDescription ?? data.responseDescription ?? data.message ?? "").slice(0, 500),
        amountPaise: amountToPaise(data.amount),
        gatewayTxnId: data.txnID ? String(data.txnID) : data.paymentID ? String(data.paymentID) : null,
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
        throw new JiopayError("INITIATE_REJECTED", `initiateSale rejected: ${data.responseCode} ${data.respDescription || ""}`.trim());
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
    const hashValid = verifyPayloadHash(data);
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