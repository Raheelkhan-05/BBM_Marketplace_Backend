// src/middleware/partnerAuth.middleware.js
import crypto from "crypto";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

// Static access-token auth for the integration API. The token lives ONLY in env (PARTNER_API_TOKEN).
export function requirePartnerToken(req, res, next) {
    const secret = process.env.PARTNER_API_TOKEN;
    if (!secret) {
        return res.status(503).json({ success: false, message: "Service unavailable.", request_id: req.partnerRequestId });
    }
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const ok = token && crypto.timingSafeEqual(sha(token), sha(secret));
    if (!ok) {
        return res.status(401).json({ success: false, message: "Unauthorized.", request_id: req.partnerRequestId });
    }
    // Optional label the caller may send to tag a run/job; shows up in the request log.
    req.partnerActor = (req.get("x-client-ref") || "partner-integration").slice(0, 80);
    req.partnerBuyerId = process.env.PARTNER_BUYER_ID || null;
    next();
}

// RFQ routes act as ONE dedicated buyer account (PARTNER_BUYER_ID = a profiles.id with role 'user').
export function requirePartnerBuyer(req, res, next) {
    if (!req.partnerBuyerId) {
        return res.status(503).json({ success: false, message: "Service unavailable.", request_id: req.partnerRequestId });
    }
    next();
}