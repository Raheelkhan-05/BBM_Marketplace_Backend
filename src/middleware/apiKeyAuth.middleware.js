// src/middleware/apiKeyAuth.middleware.js
import crypto from "crypto";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

export function requireApiKey(req, res, next) {
    const secret = process.env.API_ACCESS_KEY;
    if (!secret) {
        return res.status(503).json({
            success: false, code: "NOT_CONFIGURED",
            message: "API access is not configured.", request_id: req.apiRequestId,
        });
    }
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const ok = token && crypto.timingSafeEqual(sha(token), sha(secret));
    if (!ok) {
        return res.status(401).json({
            success: false, code: "UNAUTHORIZED",
            message: "Invalid or missing access token.", request_id: req.apiRequestId,
        });
    }
    req.apiActor = (process.env.API_ACCESS_ACTOR || "api-client").slice(0, 80);
    next();
}