// src/controllers/salesMonitor.controller.js
// Team admin / owner only: what the company's salespeople are doing (enquiries, order book, customers).
import { supabaseAdmin } from "../config/supabase.js";
import { getTeamContext } from "../services/team.service.js";
import { isUuid } from "../services/rfqValidation.js";
import { cached, getVer, hashKey } from "../services/cache.service.js";
import { hydrateEntries, threadDto } from "../services/salesThreads.service.js";
import { WORK_START_MIN, WORK_END_MIN, IDLE_LIMIT_MIN } from "../services/salesMonitor.service.js";

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MODULES = ["enquiry", "order", "customer"];
const FEED_PAGE = 30, FEED_MAX = 60, AFTER_MAX = 100, ENTRY_PAGE = 30;

const actorIdOf = (req) => req.actor?.id || req.user.id;
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const oops = (res, e, where) => { console.error(`[sales monitor] ${where}:`, e?.message || e); return fail(res, 500, "Something went wrong. Please try again."); };
const safeSearch = (q) => String(q || "").replace(/[%_,()\\*]/g, " ").trim().toLowerCase().slice(0, 80);
const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const isoOf = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : new Date(t).toISOString(); };

async function requireAdmin(req, res) {
    const ctx = await getTeamContext(actorIdOf(req));
    if (!ctx.isAdmin) { fail(res, 403, "Only your team admin can do this."); return null; }
    return ctx;
}

// from / to are inclusive IST dates (YYYY-MM-DD). Returns timestamps [fromTs, toTs).
function rangeOf(query, { required }) {
    let from = DATE_RE.test(query.from || "") ? query.from : null;
    let to = DATE_RE.test(query.to || "") ? query.to : null;
    if (required) {
        if (!from && !to) from = to = istDate(Date.now());
        else if (!from) from = to; else if (!to) to = from;
    }
    if (from && to && from > to) [from, to] = [to, from];
    const f = from ? Date.parse(`${from}T00:00:00+05:30`) : NaN;
    const t = to ? Date.parse(`${to}T00:00:00+05:30`) + DAY_MS : NaN;
    if (Number.isFinite(f) && Number.isFinite(t) && t - f > 366 * DAY_MS) return { error: "Choose a range of up to one year." };
    return { from, to, fromTs: Number.isFinite(f) ? new Date(f).toISOString() : null, toTs: Number.isFinite(t) ? new Date(t).toISOString() : null };
}

/* ------------------------------ GET /people ------------------------------ */
export async function getPeople(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const r = rangeOf(req.query, { required: true });
        if (r.error) return fail(res, 400, r.error);

        const ver = await getVer(`sm:${ctx.companyId}`);
        const body = await cached(`smp:${ctx.companyId}:${ver}:${hashKey([r.from, r.to])}`, 20, async () => {
            let members = [];
            if (ctx.teamId) {
                const { data, error } = await supabaseAdmin.from("team_members").select("user_id, joined_at")
                    .eq("team_id", ctx.teamId).eq("role", "salesperson");
                if (error) throw error;
                members = data || [];
            }
            const ids = members.map((m) => m.user_id);
            let profs = [], stats = [];
            if (ids.length) {
                const [p, s] = await Promise.all([
                    supabaseAdmin.from("profiles").select("id, name, phone, email").in("id", ids),
                    supabaseAdmin.rpc("sales_activity_summary", { p_company: ctx.companyId, p_actors: ids, p_from: r.fromTs, p_to: r.toTs }),
                ]);
                if (p.error) throw p.error;
                if (s.error) throw s.error;
                profs = p.data || []; stats = s.data || [];
            }
            const pById = new Map(profs.map((p) => [p.id, p]));
            const sById = new Map(stats.map((s) => [s.actor_id, s]));
            const people = members.map((m) => {
                const p = pById.get(m.user_id) || {}, s = sById.get(m.user_id) || {};
                return {
                    userId: m.user_id, name: p.name || p.email || p.phone || "Unnamed", phone: p.phone || null, email: p.email || null,
                    total: Number(s.total || 0), enquiries: Number(s.enquiries || 0), orders: Number(s.orders || 0), customers: Number(s.customers || 0),
                    idleCount: Number(s.idle_count || 0), longestGap: Number(s.longest_gap || 0),
                    firstAt: s.first_at || null, lastAt: s.last_at || null, lastAny: s.last_any || null,
                };
            }).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
            return {
                success: true, people, from: r.from, to: r.to,
                work: { startMin: WORK_START_MIN, endMin: WORK_END_MIN, idleMin: IDLE_LIMIT_MIN },
            };
        });
        res.json(body);
    } catch (e) { oops(res, e, "getPeople"); }
}

/* ------------------------------ GET /feed ------------------------------ */
// ?actorId&module&idleOnly=1&q&from&to&limit&before&beforeId | after
const dto = (r) => ({
    id: r.id, actorId: r.actor_id, actorName: r.actor_name, module: r.module, kind: r.kind,
    title: r.title, subtitle: r.subtitle, preview: r.preview, entityType: r.entity_type, entityId: r.entity_id,
    meta: r.meta || {}, gapMinutes: r.gap_minutes, idle: !!r.idle_flag, createdAt: r.created_at,
});

export async function getFeed(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const qy = req.query;
        const r = rangeOf(qy, { required: false });
        if (r.error) return fail(res, 400, r.error);

        const limit = Math.min(Math.max(parseInt(qy.limit, 10) || FEED_PAGE, 1), FEED_MAX);
        const actorId = isUuid(qy.actorId) ? String(qy.actorId) : "";
        const module = MODULES.includes(qy.module) ? qy.module : "";
        const idleOnly = qy.idleOnly === "1";
        const search = safeSearch(qy.q);
        const before = qy.before ? isoOf(qy.before) : null;
        const beforeId = isUuid(qy.beforeId) ? String(qy.beforeId) : "";
        const after = qy.after ? isoOf(qy.after) : null;
        if ((qy.before && !before) || (qy.after && !after)) return fail(res, 400, "Invalid cursor.");

        const ver = await getVer(`sm:${ctx.companyId}`);
        const key = `smf:${ctx.companyId}:${ver}:${hashKey([actorId, module, idleOnly, search, r.fromTs, r.toTs, limit, before, beforeId, after])}`;
        const body = await cached(key, 30, async () => {
            let q = supabaseAdmin.from("sales_activity").select("*").eq("company_id", ctx.companyId);
            if (actorId) q = q.eq("actor_id", actorId);
            if (module) q = q.eq("module", module);
            if (idleOnly) q = q.eq("idle_flag", true);
            if (search) q = q.ilike("search_text", `%${search}%`);
            if (r.fromTs) q = q.gte("created_at", r.fromTs);
            if (r.toTs) q = q.lt("created_at", r.toTs);

            if (after) {
                const { data, error } = await q.gte("created_at", after)
                    .order("created_at", { ascending: true }).order("id", { ascending: true }).limit(AFTER_MAX + 1);
                if (error) throw error;
                if ((data || []).length > AFTER_MAX) return { success: true, events: [], hasMore: false, reset: true };
                return { success: true, events: (data || []).reverse().map(dto), hasMore: false };
            }
            if (before) {
                q = beforeId ? q.or(`created_at.lt.${before},and(created_at.eq.${before},id.lt.${beforeId})`) : q.lt("created_at", before);
            }
            const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
            if (error) throw error;
            const rows = data || [];
            return { success: true, events: rows.slice(0, limit).map(dto), hasMore: rows.length > limit };
        });
        res.json(body);
    } catch (e) { oops(res, e, "getFeed"); }
}

/* ------------------------------ GET /threads/:id ------------------------------ */
// Read-only view of any salesperson's enquiry thread of this company.
// ?limit&before&beforeId  (newest page first, older pages by cursor)
const threadOf = (row, extra) => ({
    ...threadDto(row, extra),
    outcome: row.sales_outcome || null,
    reminderAt: row.reminder_at || null,
    salespersonId: row.created_by_actor_id || null,
    salespersonName: row.created_by_actor_name || null,
});

export async function getThreadView(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const { id } = req.params;
        if (!isUuid(id)) return fail(res, 404, "Enquiry not found.");

        const { data: row, error: rErr } = await supabaseAdmin.from("rfq_enquiries").select("*")
            .eq("id", id).eq("source", "sales").eq("buyer_id", ctx.companyId).maybeSingle();
        if (rErr) throw rErr;
        if (!row) return fail(res, 404, "Enquiry not found.");

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || ENTRY_PAGE, 1), 50);
        const before = req.query.before ? isoOf(req.query.before) : null;
        const beforeId = isUuid(req.query.beforeId) ? String(req.query.beforeId) : "";
        if (req.query.before && !before) return fail(res, 400, "Invalid cursor.");

        let q = supabaseAdmin.from("sales_thread_entries").select("*").eq("enquiry_id", row.id)
            .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
        if (before) q = beforeId ? q.or(`created_at.lt.${before},and(created_at.eq.${before},id.lt.${beforeId})`) : q.lt("created_at", before);

        const [list, qc] = await Promise.all([
            q,
            supabaseAdmin.from("sales_quotes").select("id", { count: "exact", head: true }).eq("enquiry_id", row.id),
        ]);
        if (list.error) throw list.error;
        const data = list.data || [];
        res.json({
            success: true, thread: threadOf(row, { quotesCount: qc.count || 0 }),
            entries: await hydrateEntries(data.slice(0, limit).reverse()), hasOlder: data.length > limit,
        });
    } catch (e) { oops(res, e, "getThreadView"); }
}