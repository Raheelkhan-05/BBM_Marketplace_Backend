// src/middleware/seoRequestLogger.middleware.js
// Logs every call to /api/seo/* (input) plus a capped copy of what we returned (output).
import crypto from "crypto";
import { supabaseAdmin } from "../config/supabase.js";

const LOG_SPA_READS = process.env.SEO_LOG_SPA_READS === "true"; // browser reads are noisy; off by default

function cap(value, max = 4000) {
    if (value === undefined || value === null) return null;
    try {
        const s = JSON.stringify(value);
        if (s === "{}") return null;
        return s.length > max ? { truncated: true, bytes: s.length } : value;
    } catch {
        return null;
    }
}

export function seoRequestLogger(req, res, next) {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    req.seoRequestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    let payload;
    const origJson = res.json.bind(res);
    res.json = (body) => {
        payload = body;
        return origJson(body);
    };

    res.on("finish", () => {
        const hint = (req.get("x-seo-source") || "").toLowerCase();
        const source = req.seoActor ? "automation" : hint === "edge" || hint === "spa" ? hint : "other";
        if (source === "spa" && !LOG_SPA_READS) return;

        supabaseAdmin
            .from("seo_request_log")
            .insert({
                request_id: requestId,
                source,
                actor: req.seoActor || "public",
                method: req.method,
                path: `${req.baseUrl}${req.path}`,
                query: cap(req.query),
                body: req.method === "GET" ? null : cap(req.body),
                status: res.statusCode,
                duration_ms: Date.now() - started,
                ip: req.ip,
                user_agent: (req.get("user-agent") || "").slice(0, 300),
                response_summary: cap(payload),
            })
            .then(({ error }) => {
                if (error) console.error("[seo-log] insert failed:", error.message);
            });
    });

    next();
}