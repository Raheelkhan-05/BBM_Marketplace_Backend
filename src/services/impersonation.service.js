// src/services/impersonation.service.js
import crypto from "node:crypto";
import { supabaseAdmin } from "../config/supabase.js";

export const SESSION_TTL_MINUTES = Number(process.env.IMPERSONATION_TTL_MINUTES) || 120;
export const CODE_TTL_SECONDS = 60;

export const newCode = () => crypto.randomBytes(32).toString("base64url");
export const hashCode = (code) => crypto.createHash("sha256").update(String(code)).digest("hex");

// pending = code issued, not opened yet | unused = code expired unopened
export function statusOf(s) {
    const now = Date.now();
    if (s.ended_at) return "ended";
    if (!s.started_at) return new Date(s.code_expires_at).getTime() > now ? "pending" : "unused";
    return new Date(s.expires_at).getTime() > now ? "active" : "expired";
}

/* ---------------------------- policy ---------------------------- */
// Blocked while impersonating (writes only): identity takeover and money leaving the platform.
// Remove a line here if you decide an admin should be allowed to do that action.
const BLOCKED = [
    [/^\/api\/auth\/contact(\/|$)/, "Phone and email changes need the user's own OTP, so they are blocked in admin sessions."],
    [/^\/api\/seller\/onboarding\/whatsapp(\/|$)/, "WhatsApp verification needs the user's own OTP."],
    [/^\/api\/seller\/bank-details$/, "Payout bank details can only be changed by the account owner."],
    [/^\/api\/seller\/wallet(\/|$)/, "Wallet actions are blocked in admin sessions."],
    [/^\/api\/payments(\/|$)/, "Payments can't be started from an admin session."],
    [/^\/api\/orders\/[^/]+\/payment-proof$/, "Payment proofs can't be submitted from an admin session."],
    [/^\/api\/team(\/|$)/, "Team access can only be managed by the account owner."],
    [/^\/api\/sales-chat\/threads\/[^/]+\/(messages|participants(\/[^/]+)?)$/, "Chat messages and membership changes are sent in the user's name, so they are blocked in admin sessions."],
];
export const blockedReason = (path) => BLOCKED.find(([re]) => re.test(path))?.[1] || null;

// Side-effect-only writes that would change the real user's state (read receipts, unread counters,
// price observations). Answered with a fake success so the UI keeps working but nothing is written.
const NOOP = [
    /^\/api\/(chat|sales-chat)\/.+\/(read|delivered|typing|seen)$/,
    /^\/api\/notifications\/(read-all|[^/]+\/read)$/,
    /^\/api\/help\/[^/]+\/seen$/,
    /^\/api\/catalog\/price-trends\/observe$/,
];
export const isNoop = (path) => NOOP.some((re) => re.test(path));

/* ------------------------ session lookup ------------------------ */
// 10s cache: every request of an impersonated session passes through here.
// A revoke takes effect on this instance immediately and on others within 10s.
const CACHE_MS = 10_000;
const cache = new Map();
export const forgetSession = (id) => cache.delete(String(id));

export async function loadActiveSession(id) {
    const key = String(id);
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;

    const { data: s, error } = await supabaseAdmin
        .from("admin_impersonation_sessions")
        .select("id, admin_id, target_user_id, reason, started_at, expires_at, ended_at")
        .eq("id", key).maybeSingle();
    if (error) throw error;

    let v = null;
    if (s && s.started_at && !s.ended_at && new Date(s.expires_at).getTime() > Date.now()) {
        const [a, t] = await Promise.all([
            supabaseAdmin.from("profiles").select("id").eq("id", s.admin_id).eq("role", "admin").is("deleted_at", null).maybeSingle(),
            supabaseAdmin.from("profiles").select("id").eq("id", s.target_user_id).eq("role", "user").is("deleted_at", null).maybeSingle(),
        ]);
        if (a.error) throw a.error;
        if (t.error) throw t.error;
        if (a.data && t.data) v = s;
    }

    if (cache.size > 2000) cache.clear();
    cache.set(key, { v, exp: Date.now() + CACHE_MS });
    return v;
}