// src/services/salesMonitor.service.js
// Records what salespeople do (enquiries, order book, customers) for the team admin's Sales monitor.
// Gap rule (per salesperson, IST): only events between 9:00 AM and 6:00 PM can be flagged. The gap is measured from
// the salesperson's previous event, or from 9:00 AM if that was earlier / on another day. Over 30 min => red.
import { supabaseAdmin } from "../config/supabase.js";
import { emitToUser } from "./realtimeBroadcast.js";
import { bumpVer } from "./cache.service.js";

export const WORK_START_MIN = 9 * 60;
export const WORK_END_MIN = 18 * 60;
export const IDLE_LIMIT_MIN = 30;
const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

export const istDayStart = (ms) => Math.floor((ms + IST_MS) / DAY_MS) * DAY_MS - IST_MS;

export function evaluateGap(prevMs, nowMs) {
    const day = istDayStart(nowMs);
    const open = day + WORK_START_MIN * 60_000;
    const close = day + WORK_END_MIN * 60_000;
    if (nowMs < open || nowMs > close) return { gap: null, idle: false, from: null };
    const hasPrev = Number.isFinite(prevMs) && prevMs <= nowMs && prevMs >= open;
    const base = hasPrev ? prevMs : open;
    return {
        gap: Math.round((nowMs - base) / 60_000),
        idle: nowMs - base > IDLE_LIMIT_MIN * 60_000,
        from: hasPrev ? "previous" : "day_start",
    };
}

/* ---------------------- realtime ping (leading + trailing throttle) ---------------------- */
const adminCache = new Map();
async function adminIds(companyId, teamId) {
    const hit = adminCache.get(companyId);
    if (hit && hit.exp > Date.now()) return hit.ids;
    const ids = new Set([String(companyId)]);
    if (teamId) {
        const { data } = await supabaseAdmin.from("team_members").select("user_id").eq("team_id", teamId).eq("role", "admin");
        (data || []).forEach((m) => ids.add(String(m.user_id)));
    }
    if (adminCache.size > 2000) adminCache.clear();
    const out = [...ids];
    adminCache.set(companyId, { ids: out, exp: Date.now() + 60_000 });
    return out;
}

const pings = new Map();
function ping(companyId, teamId) {
    const st = pings.get(companyId);
    if (st) { st.dirty = true; return; }
    adminIds(companyId, teamId)
        .then((ids) => ids.forEach((id) => emitToUser(id, "sales:monitor", { companyId })))
        .catch((e) => console.error("[sales monitor] ping failed:", e?.message || e));
    const state = { dirty: false };
    state.timer = setTimeout(() => {
        pings.delete(companyId);
        if (state.dirty) ping(companyId, teamId);
    }, 700);
    pings.set(companyId, state);
}

/* ---------------------------------- logging ---------------------------------- */
export async function logSalesActivity({
    companyId, teamId = null, actorId, actorName = null, module, kind, entityType = null, entityId = null,
    title, subtitle = null, preview = null, meta = {},
}) {
    try {
        if (!companyId || !actorId) return;
        const nowMs = Date.now();
        const { data: last } = await supabaseAdmin.from("sales_activity").select("created_at")
            .eq("actor_id", actorId).order("created_at", { ascending: false }).limit(1).maybeSingle();
        const g = evaluateGap(last ? Date.parse(last.created_at) : NaN, nowMs);

        const { error } = await supabaseAdmin.from("sales_activity").insert({
            company_id: companyId, team_id: teamId, actor_id: actorId, actor_name: actorName,
            module, kind, entity_type: entityType, entity_id: entityId || null,
            title, subtitle, preview,
            meta: g.idle ? { ...meta, gapFrom: g.from } : meta,
            gap_minutes: g.gap, idle_flag: g.idle, created_at: new Date(nowMs).toISOString(),
        });
        if (error) { console.error("[sales monitor] insert failed:", error.message); return; }

        await bumpVer(`sm:${companyId}`);   // cached reads are invalid BEFORE the admin is pinged
        ping(companyId, teamId);
    } catch (e) {
        console.error("[sales monitor] log failed:", e?.message || e);
    }
}