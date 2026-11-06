// src/middleware/partnerRequestLogger.middleware.js
// Records every call (input) plus a capped copy of what we returned (output). Never stores headers/tokens.
import crypto from "crypto";
import { supabaseAdmin } from "../config/supabase.js";

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

export function partnerRequestLogger(req, res, next) {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    const fullPath = req.originalUrl.split("?")[0];
    req.partnerRequestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    let payload;
    const origJson = res.json.bind(res);
    res.json = (body) => {
        payload = body;
        return origJson(body);
    };

    res.on("finish", () => {
        supabaseAdmin
            .from("partner_request_log")
            .insert({
                request_id: requestId,
                actor: req.partnerActor || "anonymous", // anonymous = failed / missing token
                method: req.method,
                path: fullPath,
                query: cap(req.query),
                body: req.method === "GET" ? null : cap(req.body),
                status: res.statusCode,
                duration_ms: Date.now() - started,
                ip: req.ip,
                user_agent: (req.get("user-agent") || "").slice(0, 300),
                response_summary: cap(payload),
            })
            .then(({ error }) => {
                if (error) console.error("[partner-log] insert failed:", error.message);
            });
    });

    next();
}