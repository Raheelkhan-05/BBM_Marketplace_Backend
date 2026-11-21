// src/controllers/adminImpersonation.controller.js
import { supabaseAdmin } from "../config/supabase.js";
import { isUuid } from "../services/rfqValidation.js";
import { getTeamContext } from "../services/team.service.js";
import { newCode, hashCode, CODE_TTL_SECONDS, statusOf } from "../services/impersonation.service.js";
import { forgetSession } from "../services/impersonation.service.js";

const fail = (res, status, message, code) => res.status(status).json({ success: false, message, ...(code ? { code } : {}) });
const oops = (res, e, where) => { console.error(`[impersonation] ${where}:`, e?.message || e); return fail(res, 500, "Something went wrong. Please try again."); };
const ipOf = (req) => (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim() || null;
const clean = (q) => String(q || "").replace(/[%_,()\\*]/g, " ").trim().slice(0, 80);
const companyLabel = (b, s) => b?.display_name?.trim() || s?.display_name?.trim() || b?.trade_name?.trim() || b?.legal_name?.trim() || null;

// Only a REAL admin (re-checked in the DB) may use these routes, and never from inside an impersonated session.
export async function requireRealAdmin(req, res, next) {
    try {
        if (req.impersonation) return fail(res, 403, "Not available inside an admin session.");
        const { data, error } = await supabaseAdmin.from("profiles").select("id, name")
            .eq("id", req.user.id).eq("role", "admin").is("deleted_at", null).maybeSingle();
        if (error) throw error;
        if (!data) return fail(res, 403, "Unauthorized access.");
        req.admin = data;
        next();
    } catch (e) { oops(res, e, "requireRealAdmin"); }
}

// GET /api/admin/impersonation/search?q=
export async function searchUsers(req, res) {
    try {
        const q = clean(req.query.q);
        if (q.length < 2) return res.json({ success: true, items: [] });

        const digits = q.replace(/\D/g, "");
        const or = [`name.ilike.%${q}%`, `email.ilike.%${q}%`];
        if (digits.length >= 4) or.push(`phone.ilike.%${digits}%`);

        const [byProfile, byBiz] = await Promise.all([
            supabaseAdmin.from("profiles").select("id, name, phone, email, onboarding_step")
                .eq("role", "user").is("deleted_at", null).or(or.join(",")).limit(20),
            supabaseAdmin.from("business_profiles").select("user_id")
                .or(`gstin.ilike.%${q}%,legal_name.ilike.%${q}%,trade_name.ilike.%${q}%,display_name.ilike.%${q}%`).limit(20),
        ]);
        if (byProfile.error) throw byProfile.error;
        if (byBiz.error) throw byBiz.error;

        const have = new Map((byProfile.data || []).map((p) => [p.id, p]));
        const extra = (byBiz.data || []).map((b) => b.user_id).filter((id) => id && !have.has(id));
        if (extra.length) {
            const { data, error } = await supabaseAdmin.from("profiles").select("id, name, phone, email, onboarding_step")
                .in("id", extra).eq("role", "user").is("deleted_at", null);
            if (error) throw error;
            (data || []).forEach((p) => have.set(p.id, p));
        }

        // team members act through their company: the company is what an admin opens
        const people = [...have.values()].filter((p) => p.onboarding_step !== "team_member").slice(0, 25);
        const ids = people.map((p) => p.id);
        if (!ids.length) return res.json({ success: true, items: [] });

        const [biz, sel] = await Promise.all([
            supabaseAdmin.from("business_profiles").select("user_id, gstin, display_name, trade_name, legal_name").in("user_id", ids),
            supabaseAdmin.from("seller_profiles").select("user_id, status, display_name").in("user_id", ids),
        ]);
        const bBy = new Map((biz.data || []).map((b) => [b.user_id, b]));
        const sBy = new Map((sel.data || []).map((s) => [s.user_id, s]));

        res.json({
            success: true,
            items: people.map((p) => ({
                id: p.id, name: p.name || null, phone: p.phone || null, email: p.email || null,
                company: companyLabel(bBy.get(p.id), sBy.get(p.id)), gstin: bBy.get(p.id)?.gstin || null,
                isSeller: sBy.has(p.id), sellerStatus: sBy.get(p.id)?.status || null, onboarded: p.onboarding_step === "done",
            })),
        });
    } catch (e) { oops(res, e, "search"); }
}

async function resolveTarget(userId) {
    const load = (id) => supabaseAdmin.from("profiles").select("id, name, phone, email, role, onboarding_step, deleted_at").eq("id", id).maybeSingle();
    const { data: p, error } = await load(userId);
    if (error) throw error;
    if (!p || p.deleted_at) return { error: { status: 404, message: "User not found." } };
    if (p.role !== "user") return { error: { status: 403, message: "Admin accounts can't be impersonated." } };

    let target = p, viaTeamMember = false;
    if (p.onboarding_step === "team_member") {
        const ctx = await getTeamContext(p.id);
        if (ctx.companyId && ctx.companyId !== p.id) {
            const { data: owner, error: oErr } = await load(ctx.companyId);
            if (oErr) throw oErr;
            if (!owner || owner.deleted_at || owner.role !== "user") return { error: { status: 404, message: "This user's company account wasn't found." } };
            target = owner; viaTeamMember = true;
        }
    }
    return { target, viaTeamMember };
}

// POST /api/admin/impersonation/start { userId | sellerId, reason }
export async function startImpersonation(req, res) {
    try {
        const base = String(process.env.FRONTEND_URL || "").replace(/\/$/, "");
        if (!base) return fail(res, 500, "FRONTEND_URL is not configured on the server.");

        const reason = String(req.body?.reason || "").trim();
        if (reason.length < 5 || reason.length > 300) return fail(res, 400, "Enter a reason (5 to 300 characters).");

        let userId = req.body?.userId;
        if (!userId && req.body?.sellerId) {
            if (!isUuid(req.body.sellerId)) return fail(res, 400, "Invalid seller.");
            const { data, error } = await supabaseAdmin.from("seller_profiles").select("user_id").eq("id", req.body.sellerId).maybeSingle();
            if (error) throw error;
            userId = data?.user_id;
        }
        if (!isUuid(userId)) return fail(res, 400, "Choose a user.");

        const r = await resolveTarget(userId);
        if (r.error) return fail(res, r.error.status, r.error.message);
        const { target, viaTeamMember } = r;

        const code = newCode();
        const { data: session, error } = await supabaseAdmin.from("admin_impersonation_sessions").insert({
            admin_id: req.admin.id, target_user_id: target.id, reason,
            code_hash: hashCode(code), code_expires_at: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
            ip: ipOf(req), user_agent: String(req.headers["user-agent"] || "").slice(0, 300),
        }).select("id").single();
        if (error) throw error;

        const [{ data: b }, { data: s }] = await Promise.all([
            supabaseAdmin.from("business_profiles").select("display_name, trade_name, legal_name").eq("user_id", target.id).maybeSingle(),
            supabaseAdmin.from("seller_profiles").select("display_name").eq("user_id", target.id).maybeSingle(),
        ]);

        console.info(`[impersonation] start session=${session.id} admin=${req.admin.id} target=${target.id}`);
        res.json({
            success: true, code, url: `${base}/impersonate`, expiresInSeconds: CODE_TTL_SECONDS, viaTeamMember,
            target: { id: target.id, name: target.name || null, company: companyLabel(b, s) },
        });
    } catch (e) { oops(res, e, "start"); }
}

// GET /api/admin/impersonation/sessions?userId=&status=active&limit=&before=
export async function listSessions(req, res) {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        let q = supabaseAdmin.from("admin_impersonation_sessions").select("*")
            .order("created_at", { ascending: false }).limit(limit + 1);
        if (isUuid(req.query.userId)) q = q.eq("target_user_id", req.query.userId);
        if (req.query.status === "active") {
            q = q.not("started_at", "is", null).is("ended_at", null).gt("expires_at", new Date().toISOString());
        }
        if (req.query.before && !Number.isNaN(Date.parse(req.query.before))) q = q.lt("created_at", req.query.before);

        const { data, error } = await q;
        if (error) throw error;
        const page = (data || []).slice(0, limit);

        const ids = [...new Set(page.flatMap((s) => [s.admin_id, s.target_user_id]))];
        const targetIds = [...new Set(page.map((s) => s.target_user_id))];
        const [profs, biz] = ids.length ? await Promise.all([
            supabaseAdmin.from("profiles").select("id, name, email, phone").in("id", ids),
            supabaseAdmin.from("business_profiles").select("user_id, display_name, trade_name, legal_name").in("user_id", targetIds),
        ]) : [{ data: [] }, { data: [] }];
        const pBy = new Map((profs.data || []).map((p) => [p.id, p]));
        const bBy = new Map((biz.data || []).map((b) => [b.user_id, b]));

        res.json({
            success: true,
            hasMore: (data || []).length > limit,
            nextBefore: page.length ? page[page.length - 1].created_at : null,
            items: page.map((s) => {
                const t = pBy.get(s.target_user_id), a = pBy.get(s.admin_id);
                return {
                    id: s.id, status: statusOf(s), reason: s.reason, createdAt: s.created_at, startedAt: s.started_at,
                    endedAt: s.ended_at, expiresAt: s.expires_at, endedBy: s.ended_by,
                    admin: { id: s.admin_id, name: a?.name || a?.email || a?.phone || "Admin" },
                    target: { id: s.target_user_id, name: t?.name || t?.email || t?.phone || "User", company: companyLabel(bBy.get(s.target_user_id)) },
                };
            }),
        });
    } catch (e) { oops(res, e, "list"); }
}

// GET /api/admin/impersonation/sessions/:id/log
export async function getSessionLog(req, res) {
    try {
        if (!isUuid(req.params.id)) return fail(res, 404, "Session not found.");
        const { data, error } = await supabaseAdmin.from("admin_impersonation_log")
            .select("id, method, route, status, entity_id, created_at").eq("session_id", req.params.id)
            .order("created_at", { ascending: false }).limit(200);
        if (error) throw error;
        res.json({ success: true, items: data || [] });
    } catch (e) { oops(res, e, "log"); }
}

// POST /api/admin/impersonation/sessions/:id/revoke
export async function revokeSession(req, res) {
    try {
        if (!isUuid(req.params.id)) return fail(res, 404, "Session not found.");
        const { data, error } = await supabaseAdmin.from("admin_impersonation_sessions")
            .update({ ended_at: new Date().toISOString(), ended_by: `revoked:${req.admin.id}` })
            .eq("id", req.params.id).is("ended_at", null).select("id").maybeSingle();
        if (error) throw error;
        if (!data) return fail(res, 404, "That session is already over.");
        forgetSession(req.params.id);
        console.info(`[impersonation] revoked session=${req.params.id} by=${req.admin.id}`);
        res.json({ success: true });
    } catch (e) { oops(res, e, "revoke"); }
}