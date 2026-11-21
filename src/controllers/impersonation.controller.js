// src/controllers/impersonation.controller.js
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabase.js";
import { companyNameOf } from "../services/team.service.js";
import { hashCode, forgetSession, SESSION_TTL_MINUTES } from "../services/impersonation.service.js";

const fail = (res, status, message, code) => res.status(status).json({ success: false, message, ...(code ? { code } : {}) });
const oops = (res, e, where) => { console.error(`[impersonation] ${where}:`, e?.message || e); return fail(res, 500, "Something went wrong. Please try again."); };

// The enforcer middleware sets req.impersonation only for a valid, active session token.
export function requireImpersonation(req, res, next) {
    if (!req.impersonation) return fail(res, 401, "This admin session has ended.", "IMPERSONATION_ENDED");
    next();
}

async function metaFor({ sessionId, adminId, targetId, reason, expiresAt }) {
    const [t, a, company] = await Promise.all([
        supabaseAdmin.from("profiles").select("name, email, phone").eq("id", targetId).maybeSingle(),
        supabaseAdmin.from("profiles").select("name, email").eq("id", adminId).maybeSingle(),
        companyNameOf(targetId),
    ]);
    return {
        sessionId, reason, expiresAt,
        targetName: t.data?.name || t.data?.email || t.data?.phone || "User",
        companyName: company !== "a company" ? company : null,
        adminName: a.data?.name || a.data?.email || "Admin",
    };
}

// POST /api/impersonation/exchange { code }  (public: the one-time code is the credential)
export async function exchangeCode(req, res) {
    res.set("Cache-Control", "no-store");
    try {
        if (!process.env.AUTH_JWT_SECRET) return fail(res, 500, "Server misconfigured.");
        const code = String(req.body?.code || "").trim();
        if (code.length < 32 || code.length > 128) return fail(res, 400, "This link isn't valid.");

        const now = new Date();
        const nowIso = now.toISOString();
        const expiresAt = new Date(now.getTime() + SESSION_TTL_MINUTES * 60_000).toISOString();

        // Single use, race-safe: only one request can flip code_used_at from null.
        const { data: s, error } = await supabaseAdmin.from("admin_impersonation_sessions")
            .update({ code_used_at: nowIso, started_at: nowIso, expires_at: expiresAt })
            .eq("code_hash", hashCode(code)).is("code_used_at", null).is("ended_at", null).gt("code_expires_at", nowIso)
            .select("id, admin_id, target_user_id, reason, expires_at").maybeSingle();
        if (error) throw error;
        if (!s) return fail(res, 400, "This link has expired or was already used. Open a new session from the admin panel.");

        const [a, t] = await Promise.all([
            supabaseAdmin.from("profiles").select("id").eq("id", s.admin_id).eq("role", "admin").is("deleted_at", null).maybeSingle(),
            supabaseAdmin.from("profiles").select("id").eq("id", s.target_user_id).eq("role", "user").is("deleted_at", null).maybeSingle(),
        ]);
        if (!a.data || !t.data) {
            await supabaseAdmin.from("admin_impersonation_sessions").update({ ended_at: nowIso, ended_by: "invalid" }).eq("id", s.id);
            return fail(res, 403, "This session can't be opened.");
        }

        const token = jwt.sign({ sub: s.target_user_id, ims: s.id, act: s.admin_id }, process.env.AUTH_JWT_SECRET, {
            expiresIn: SESSION_TTL_MINUTES * 60,
        });

        console.info(`[impersonation] opened session=${s.id} admin=${s.admin_id} target=${s.target_user_id}`);
        res.json({
            success: true, token,
            meta: await metaFor({ sessionId: s.id, adminId: s.admin_id, targetId: s.target_user_id, reason: s.reason, expiresAt: s.expires_at }),
        });
    } catch (e) { oops(res, e, "exchange"); }
}

// GET /api/impersonation/current : the banner polls this to notice a revoked session quickly
export async function getCurrent(req, res) {
    res.set("Cache-Control", "no-store");
    try { res.json({ success: true, meta: await metaFor(req.impersonation) }); }
    catch (e) { oops(res, e, "current"); }
}

// POST /api/impersonation/end
export async function endSession(req, res) {
    try {
        await supabaseAdmin.from("admin_impersonation_sessions")
            .update({ ended_at: new Date().toISOString(), ended_by: "admin" })
            .eq("id", req.impersonation.sessionId).is("ended_at", null);
        forgetSession(req.impersonation.sessionId);
        res.json({ success: true });
    } catch (e) { oops(res, e, "end"); }
}