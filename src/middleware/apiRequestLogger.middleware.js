// src/middleware/apiRequestLogger.middleware.js
// Logs every call to /api/v1/* (input) plus a capped copy of what we returned (output).
// Mounted BEFORE auth so rejected / rate-limited calls are recorded too.
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

function summarize(payload, max = 4000) {
    if (payload === undefined || payload === null) return null;
    try {
        const s = JSON.stringify(payload);
        if (s.length <= max) return payload;
        return {
            truncated: true,
            bytes: s.length,
            success: payload.success ?? null,
            items: Array.isArray(payload.items) ? payload.items.length : null,
            total: payload.total ?? null,
        };
    } catch {
        return null;
    }
}

export function apiRequestLogger(req, res, next) {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    req.apiRequestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    let payload;
    const origJson = res.json.bind(res);
    res.json = (body) => {
        payload = body;
        return origJson(body);
    };

    res.on("finish", () => {
        supabaseAdmin
            .from("api_request_log")
            .insert({
                request_id: requestId,
                actor: req.apiActor || "unauthenticated",
                method: req.method,
                path: `${req.baseUrl}${req.path}`,
                query: cap(req.query),
                body: req.method === "GET" ? null : cap(req.body),
                status: res.statusCode,
                duration_ms: Date.now() - started,
                ip: req.ip,
                user_agent: (req.get("user-agent") || "").slice(0, 300),
                response_summary: summarize(payload),
            })
            .then(({ error }) => {
                if (error) console.error("[api-log] insert failed:", error.message);
            });
    });

    next();
}