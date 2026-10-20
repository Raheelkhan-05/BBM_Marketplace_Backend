// src/middleware/seoAuth.middleware.js
import crypto from "crypto";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

export function requireSeoAdmin(req, res, next) {
    const secret = process.env.SEO_ADMIN_SECRET;
    if (!secret) {
        return res.status(503).json({ success: false, message: "SEO admin auth is not configured." });
    }
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const ok = token && crypto.timingSafeEqual(sha(token), sha(secret));
    if (!ok) return res.status(401).json({ success: false, message: "Unauthorized." });

    // Lets the automation label each run (e.g. "seo-bot-run-2026-10-21") so logs show who did what.
    req.seoActor = (req.get("x-seo-actor") || "seo-automation").slice(0, 80);
    next();
}