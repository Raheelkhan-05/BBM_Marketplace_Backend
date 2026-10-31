// src/middleware/apiAnalytics.middleware.js
import * as svc from "../services/analytics.service.js";

const SLOW_MS = 1500;
const SAMPLE_RATE = Math.min(1, Math.max(0, Number(process.env.API_ANALYTICS_SAMPLE_RATE ?? 0.05)));
const IGNORED = [/^\/health/, /^\/api\/my-ip/, /^\/socket\.io/, /^\/api\/notifications/];
const KEY_PATHS = [/^\/api\/orders/, /^\/api\/payments/, /^\/api\/auth/, /^\/api\/cart/, /^\/api\/rfq/, /^\/api\/seller\/order-book/];

// Collapse ids so one endpoint = one group in PostHog.
function normalizePath(p) {
    return p
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
        .replace(/\/\d+(?=\/|$)/g, "/:id");
}

export function apiAnalytics(req, res, next) {
    if (!svc.analyticsEnabled || req.method === "OPTIONS") return next();
    const path = req.originalUrl.split("?")[0]; // never log the query string
    if (IGNORED.some((re) => re.test(path))) return next();

    const start = process.hrtime.bigint();

    res.on("finish", () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        const status = res.statusCode;
        const isWrite = req.method !== "GET" && req.method !== "HEAD";
        const interesting =
            status >= 400 ||
            durationMs >= SLOW_MS ||
            (isWrite && KEY_PATHS.some((re) => re.test(path))) ||
            Math.random() < SAMPLE_RATE;
        if (!interesting) return;

        const route = req.route ? normalizePath(`${req.baseUrl}${req.route.path}`) : normalizePath(path);
        svc.captureServer(req, "api_request", {
            method: req.method,
            route,
            status_code: status,
            status_class: `${Math.floor(status / 100)}xx`,
            duration_ms: Math.round(durationMs),
            is_error: status >= 400,
            is_slow: durationMs >= SLOW_MS,
        });
    });

    next();
}