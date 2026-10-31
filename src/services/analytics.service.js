// src/services/analytics.service.js
import { PostHog } from "posthog-node";

const KEY = process.env.POSTHOG_API_KEY;
const HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";

export const analyticsEnabled = Boolean(KEY);

const client = analyticsEnabled
    ? new PostHog(KEY, { host: HOST, flushAt: 20, flushInterval: 10000 })
    : null;

// The frontend only sends this header after the user accepted analytics.
// No header => the event is recorded anonymously and linked to nobody.
// (It is client-supplied, so it is for analytics only, never for authorisation.)
export function distinctIdFromReq(req) {
    const raw = req?.headers?.["x-ph-distinct-id"];
    if (typeof raw === "string" && raw.length > 0 && raw.length <= 200) {
        return { distinctId: raw, anonymous: false };
    }
    return { distinctId: "anonymous-api", anonymous: true };
}

// Use for business events (e.g. order_placed). NEVER pass PII, tokens or payment data.
export function captureServer(req, event, properties = {}) {
    if (!client) return;
    try {
        const { distinctId, anonymous } = distinctIdFromReq(req);
        client.capture({
            distinctId,
            event,
            properties: { ...properties, source: "backend", ...(anonymous ? { $process_person_profile: false } : {}) },
        });
    } catch (e) {
        console.warn("[analytics] capture failed:", e.message);
    }
}

// For server-only events that have no browser request behind them (payment webhooks, reconciler).
// Always anonymous: never linked to a person, so it is safe for users who declined analytics.
// Use it for counts and revenue, not for per-user funnels.
export function captureServerAnon(event, properties = {}) {
    if (!client) return;
    try {
        client.capture({
            distinctId: "server-events",
            event,
            properties: { ...properties, source: "backend", $process_person_profile: false },
        });
    } catch (e) {
        console.warn("[analytics] anon capture failed:", e.message);
    }
}

export function captureServerException(err, req, properties = {}) {
    if (!client) return;
    // Blocked-origin probes are noise, not app errors.
    if (String(err?.message || "").startsWith("CORS blocked")) return;
    try {
        const { distinctId } = distinctIdFromReq(req);
        if (typeof client.captureException === "function") {
            client.captureException(err, distinctId, { source: "backend", ...properties });
        } else {
            client.capture({
                distinctId,
                event: "$exception",
                properties: { $exception_message: String(err?.message || err).slice(0, 300), source: "backend", ...properties },
            });
        }
    } catch (e) {
        console.warn("[analytics] exception capture failed:", e.message);
    }
}

export async function shutdownAnalytics() {
    if (!client) return;
    try { await client.shutdown(); } catch { /* ignore */ }
}