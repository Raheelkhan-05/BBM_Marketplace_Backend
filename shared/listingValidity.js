// shared/listingValidity.js
export const HOUR_MS = 3600000;

export const VALIDITY_OPTIONS = [
    { hours: 0.01, label: "1 min" },
    { hours: 24, label: "24 hours" },
    { hours: 48, label: "48 hours" },
    { hours: 72, label: "3 days" },
    { hours: 168, label: "1 week" },
    { hours: 240, label: "10 days" },
    { hours: 336, label: "2 weeks" },
    { hours: 360, label: "15 days" },
    { hours: 720, label: "1 month" },
    { hours: 1440, label: "2 months" },
    { hours: 2160, label: "3 months" },
];
export const DEFAULT_VALIDITY_HOURS = 720;

const ALLOWED = new Set(VALIDITY_OPTIONS.map((o) => o.hours));

export function isValidValidityHours(v) {
    return v !== "" && v != null && ALLOWED.has(Number(v));
}
export function resolveValidityHours(v) {
    return isValidValidityHours(v) ? Number(v) : DEFAULT_VALIDITY_HOURS;
}
export function validityLabel(hours) {
    const o = VALIDITY_OPTIONS.find((x) => x.hours === Number(hours));
    return o ? o.label : `${hours} hours`;
}
export function computeExpiry(fromMs, hours) {
    return new Date(fromMs + Number(hours) * HOUR_MS);
}

// Works for a DB row or a list item. Expired = the sweep marked it, or the time has passed.
export function isListingExpired(row, nowMs = Date.now()) {
    if (!row) return false;
    if (row.expired_at) return true;
    if (!row.expires_at) return false;
    const t = Date.parse(row.expires_at);
    return Number.isFinite(t) && t <= nowMs;
}

export function getListingExpiry(it, nowMs = Date.now()) {
    const none = { tracked: false, expired: false, expiringSoon: false, msLeft: null };
    if (!it || it.review_status !== "approved" || !it.expires_at) return none;
    const exp = Date.parse(it.expires_at);
    if (!Number.isFinite(exp)) return none;
    const msLeft = exp - nowMs;
    const expired = !!it.expired_at || msLeft <= 0;
    const validityMs = (Number(it.validity_hours) || 0) * HOUR_MS;
    const soonMs = Math.max(2 * HOUR_MS, Math.min(24 * HOUR_MS, validityMs * 0.2));
    return { tracked: true, expired, expiringSoon: !expired && msLeft <= soonMs, msLeft: Math.max(0, msLeft) };
}

export function formatTimeLeft(ms) {
    if (!(ms > 0)) return "0m";
    const totalMin = Math.floor(ms / 60000);
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (d >= 1) return h ? `${d}d ${h}h` : `${d}d`;
    if (h >= 1) return m ? `${h}h ${m}m` : `${h}h`;
    return m >= 1 ? `${m}m` : "<1m";
}

export function formatExpiryDate(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}