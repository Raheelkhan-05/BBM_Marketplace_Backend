// src/controllers/team.controller.js
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabase.js";
import { issueOtp, checkOtp } from "../services/otp.service.js";
import { notifyUser } from "../services/realtimeBroadcast.js";
import {
    TEAM_MAX_MEMBERS, INVITE_TTL_HOURS,
    normalizeContact, maskContact, getTeamContext, invalidateTeamContext, ensureTeam,
    isCompanyOnboarded, companyNameOf, contactConflict, newInviteToken, hashToken, enrichStoredRows,
    inviteExpiry, inviteLink, deliverInvite, logActivity,
} from "../services/team.service.js";
import { getIO } from "../socket/io.js";

const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET;
const actorIdOf = (req) => req.actor?.id || req.user.id;
const ipOf = (req) => (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim() || null;

const CONFLICT_MSG = (channel) => ({
    ALREADY_MEMBER: "This person is already in your team.",
    OTHER_COMPANY: `This ${channel === "phone" ? "mobile number" : "email"} is already registered with another company. Use a contact that isn't linked to any other account.`,
});

function serverError(res, e, where) {
    console.error(`[team] ${where}:`, e?.message || e);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
}

async function requireAdmin(req, res) {
    const ctx = await getTeamContext(actorIdOf(req));
    if (ctx.isMember && !ctx.isAdmin) {
        res.status(403).json({ success: false, code: "TEAM_ADMIN_ONLY", message: "Only your team admin can do this." });
        return null;
    }
    return ctx;
}

const shapeInvite = (i) => ({
    id: i.id, channel: i.channel, value: i.value, maskedValue: maskContact(i.channel, i.value),
    status: i.expires_at < new Date().toISOString() && i.status === "pending" ? "expired" : i.status,
    expiresAt: i.expires_at, createdAt: i.created_at,
});

/* ------------------------------- GET /api/team ------------------------------- */
export async function getTeam(req, res) {
    try {
        const actorId = actorIdOf(req);
        const ctx = await getTeamContext(actorId);
        const isAdmin = ctx.isAdmin;          // was: !ctx.isMember
        const isOwner = !ctx.isMember;

        const [onboarded, companyName, sellerRow] = await Promise.all([
            isCompanyOnboarded(ctx.companyId),
            companyNameOf(ctx.companyId),
            supabaseAdmin.from("seller_profiles").select("status").eq("user_id", ctx.companyId).maybeSingle(),
        ]);
        const sellerEnabled = sellerRow.data?.status === "approved";

        let memberRows = [];
        if (ctx.teamId) {
            const { data } = await supabaseAdmin
                .from("team_members").select("user_id, role, joined_at").eq("team_id", ctx.teamId).order("joined_at");
            memberRows = data || [];
        } else {
            memberRows = [{ user_id: actorId, role: "admin", joined_at: null }];
        }
        const ids = memberRows.map((m) => m.user_id);
        const { data: profs } = await supabaseAdmin.from("profiles").select("id, name, phone, email").in("id", ids);
        const pById = new Map((profs || []).map((p) => [p.id, p]));

        const members = memberRows.map((m) => ({
            userId: m.user_id, role: m.role, joinedAt: m.joined_at,
            name: pById.get(m.user_id)?.name || null,
            phone: pById.get(m.user_id)?.phone || null,
            email: pById.get(m.user_id)?.email || null,
            isMe: m.user_id === actorId, isOwner: m.user_id === ctx.companyId,
        }));

        let invites = [];
        if (isAdmin && ctx.teamId) {
            const { data } = await supabaseAdmin
                .from("team_invites").select("id, channel, value, status, expires_at, created_at")
                .eq("team_id", ctx.teamId).eq("status", "pending").order("created_at", { ascending: false });
            invites = (data || []).map(shapeInvite);
        }

        res.json({
            success: true, teamId: ctx.teamId, companyName,
            myRole: isAdmin ? "admin" : "member",
            canInvite: isAdmin && onboarded, companyOnboarded: onboarded, sellerEnabled,
            canManageRoles: isOwner,
            limits: { maxMembers: TEAM_MAX_MEMBERS, inviteHours: INVITE_TTL_HOURS },
            members, invites,
        });
    } catch (e) { serverError(res, e, "getTeam"); }
}

/* --------------------------- POST /api/team/invites --------------------------- */
export async function createInvite(req, res) {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const parsed = normalizeContact(req.body?.value ?? req.body?.identifier);
        if (!parsed) return res.status(400).json({ success: false, message: "Enter a valid 10-digit mobile number or email address." });

        if (!(await isCompanyOnboarded(ctx.companyId))) {
            return res.status(400).json({ success: false, code: "COMPANY_NOT_ONBOARDED", message: "Finish setting up your company before adding teammates." });
        }

        const { data: me } = await supabaseAdmin.from("profiles").select("phone, email, name").eq("id", ctx.companyId).maybeSingle();
        if (me?.[parsed.channel === "phone" ? "phone" : "email"] === parsed.value) {
            return res.status(400).json({ success: false, message: "That's your own contact." });
        }

        const conflict = await contactConflict(parsed, ctx.teamId);
        if (conflict) return res.status(409).json({ success: false, code: conflict, message: CONFLICT_MSG(parsed.channel)[conflict] });

        const teamId = await ensureTeam(ctx.companyId);

        const [{ count: memberCount }, { count: pendingCount }] = await Promise.all([
            supabaseAdmin.from("team_members").select("id", { count: "exact", head: true }).eq("team_id", teamId),
            supabaseAdmin.from("team_invites").select("id", { count: "exact", head: true })
                .eq("team_id", teamId).eq("status", "pending").gt("expires_at", new Date().toISOString()),
        ]);
        if ((memberCount || 0) + (pendingCount || 0) >= TEAM_MAX_MEMBERS) {
            return res.status(400).json({ success: false, code: "TEAM_FULL", message: `A team can have up to ${TEAM_MAX_MEMBERS} people including pending invites.` });
        }

        // Free the one-pending-per-contact slot if an old invite already lapsed.
        await supabaseAdmin.from("team_invites").update({ status: "expired" })
            .eq("team_id", teamId).eq("channel", parsed.channel).eq("value", parsed.value)
            .eq("status", "pending").lt("expires_at", new Date().toISOString());

        const token = newInviteToken();
        const { data: invite, error } = await supabaseAdmin.from("team_invites").insert({
            team_id: teamId, channel: parsed.channel, value: parsed.value,
            token_hash: hashToken(token), invited_by: actorIdOf(req), expires_at: inviteExpiry(),
        }).select("id, channel, value, status, expires_at, created_at").single();
        if (error) {
            if (error.code === "23505") {
                return res.status(409).json({ success: false, code: "INVITE_PENDING", message: "An invite is already pending for this contact. Resend or revoke it from the list." });
            }
            throw error;
        }

        const link = inviteLink(token);
        const companyName = await companyNameOf(ctx.companyId);
        const delivered = await deliverInvite({ ...parsed, link, companyName, inviterName: me?.name });

        await logActivity({
            teamId, actorId: actorIdOf(req), actorRole: "admin", category: "team", action: "team.invite_sent",
            label: `Invited ${maskContact(parsed.channel, parsed.value)} to the team`,
            entityType: "invite", entityId: invite.id, meta: { channel: parsed.channel, delivered }, ip: ipOf(req),
        });

        res.json({ success: true, invite: shapeInvite(invite), link, delivered });
    } catch (e) { serverError(res, e, "createInvite"); }
}

/* ------------------------ POST /api/team/invites/:id/resend ------------------------ */
export async function resendInvite(req, res) {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        if (!ctx.teamId) return res.status(404).json({ success: false, message: "Invite not found." });

        const { data: inv } = await supabaseAdmin.from("team_invites").select("*")
            .eq("id", req.params.id).eq("team_id", ctx.teamId).maybeSingle();
        if (!inv) return res.status(404).json({ success: false, message: "Invite not found." });
        if (inv.status === "accepted" || inv.status === "revoked") {
            return res.status(400).json({ success: false, message: "This invite can't be resent. Send a new one instead." });
        }

        const conflict = await contactConflict({ channel: inv.channel, value: inv.value }, ctx.teamId);
        if (conflict) return res.status(409).json({ success: false, code: conflict, message: CONFLICT_MSG(inv.channel)[conflict] });

        const token = newInviteToken();
        const { data: updated, error } = await supabaseAdmin.from("team_invites")
            .update({ token_hash: hashToken(token), status: "pending", expires_at: inviteExpiry() })
            .eq("id", inv.id).in("status", ["pending", "expired"])
            .select("id, channel, value, status, expires_at, created_at").maybeSingle();
        if (error) throw error;
        if (!updated) return res.status(400).json({ success: false, message: "This invite can't be resent." });

        const link = inviteLink(token);
        const [companyName, { data: me }] = await Promise.all([
            companyNameOf(ctx.companyId),
            supabaseAdmin.from("profiles").select("name").eq("id", ctx.companyId).maybeSingle(),
        ]);
        const delivered = await deliverInvite({ channel: inv.channel, value: inv.value, link, companyName, inviterName: me?.name });

        await logActivity({
            teamId: ctx.teamId, actorId: actorIdOf(req), actorRole: "admin", category: "team", action: "team.invite_resent",
            label: `Resent the invite to ${maskContact(inv.channel, inv.value)}`, entityType: "invite", entityId: inv.id, ip: ipOf(req),
        });
        res.json({ success: true, invite: shapeInvite(updated), link, delivered });
    } catch (e) { serverError(res, e, "resendInvite"); }
}

/* ------------------------- DELETE /api/team/invites/:id ------------------------- */
export async function revokeInvite(req, res) {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        if (!ctx.teamId) return res.status(404).json({ success: false, message: "Invite not found." });

        const { data: inv, error } = await supabaseAdmin.from("team_invites").update({ status: "revoked" })
            .eq("id", req.params.id).eq("team_id", ctx.teamId).eq("status", "pending")
            .select("id, channel, value").maybeSingle();
        if (error) throw error;
        if (!inv) return res.status(404).json({ success: false, message: "That invite is no longer pending." });

        await logActivity({
            teamId: ctx.teamId, actorId: actorIdOf(req), actorRole: "admin", category: "team", action: "team.invite_revoked",
            label: `Cancelled the invite to ${maskContact(inv.channel, inv.value)}`, entityType: "invite", entityId: inv.id, ip: ipOf(req),
        });
        res.json({ success: true });
    } catch (e) { serverError(res, e, "revokeInvite"); }
}

/* ------------------------ DELETE /api/team/members/:userId ------------------------ */
export async function removeMember(req, res) {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const targetId = req.params.userId;
        if (!ctx.teamId) return res.status(404).json({ success: false, message: "Member not found." });
        if (targetId === ctx.companyId) return res.status(400).json({ success: false, message: "The team admin can't be removed." });

        const { data: row } = await supabaseAdmin.from("team_members").select("id")
            .eq("team_id", ctx.teamId).eq("user_id", targetId).maybeSingle();
        if (!row) return res.status(404).json({ success: false, message: "Member not found." });

        const { data: target } = await supabaseAdmin.from("team_members").select("role")
            .eq("id", row.id).maybeSingle();
        if (target?.role === "admin" && ctx.isMember) {
            return res.status(403).json({ success: false, message: "Only the company owner can remove an admin." });
        }

        const { data: prof } = await supabaseAdmin.from("profiles").select("name, phone, email").eq("id", targetId).maybeSingle();

        const { error } = await supabaseAdmin.from("team_members").delete().eq("id", row.id);
        if (error) throw error;
        invalidateTeamContext(targetId);
        getIO().in(`user:${targetId}`).disconnectSockets(true);

        // Free the contact so it can be used again later, and end this person's access.
        // Guarded on onboarding_step so a real company account can never be touched here.
        await supabaseAdmin.from("profiles").update({
            deleted_at: new Date().toISOString(), phone: null, email: null, phone_verified: false, email_verified: false,
        }).eq("id", targetId).eq("onboarding_step", "team_member");

        await logActivity({
            teamId: ctx.teamId, actorId: actorIdOf(req), actorRole: "admin", category: "team", action: "team.member_removed",
            label: `Removed ${prof?.name || prof?.email || prof?.phone || "a member"} from the team`,
            entityType: "member", entityId: targetId,
            meta: { name: prof?.name || null, phone: prof?.phone || null, email: prof?.email || null }, ip: ipOf(req),
        });
        res.json({ success: true });
    } catch (e) { serverError(res, e, "removeMember"); }
}

/* ------------------- PATCH /api/team/members/:userId/role ------------------- */
export async function setMemberRole(req, res) {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        if (ctx.isMember) {
            return res.status(403).json({ success: false, code: "OWNER_ONLY", message: "Only the company owner can change roles." });
        }
        const role = req.body?.role;
        if (role !== "admin" && role !== "member") {
            return res.status(400).json({ success: false, message: "Invalid role." });
        }
        const targetId = req.params.userId;
        if (!ctx.teamId) return res.status(404).json({ success: false, message: "Member not found." });
        if (targetId === ctx.companyId) {
            return res.status(400).json({ success: false, message: "The company owner's role can't be changed." });
        }

        const { data: row } = await supabaseAdmin.from("team_members").select("id, role")
            .eq("team_id", ctx.teamId).eq("user_id", targetId).maybeSingle();
        if (!row) return res.status(404).json({ success: false, message: "Member not found." });
        if (row.role === role) return res.json({ success: true, role });

        const { error } = await supabaseAdmin.from("team_members").update({ role }).eq("id", row.id);
        if (error) throw error;
        invalidateTeamContext(targetId);

        const { data: prof } = await supabaseAdmin.from("profiles").select("name, email, phone").eq("id", targetId).maybeSingle();
        const who = prof?.name || prof?.email || prof?.phone || "a member";
        await logActivity({
            teamId: ctx.teamId, actorId: actorIdOf(req), actorRole: "admin", category: "team",
            action: role === "admin" ? "team.member_promoted" : "team.member_demoted",
            label: role === "admin" ? `Made ${who} a team admin` : `Changed ${who} to a regular member`,
            entityType: "member", entityId: targetId, ip: ipOf(req),
        });
        res.json({ success: true, role });
    } catch (e) { serverError(res, e, "setMemberRole"); }
}

/* ------------------------------ GET /api/team/activity ------------------------------ */
export async function getActivity(req, res) {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        if (!ctx.teamId) return res.json({ success: true, events: [], hasMore: false });

        const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
        let q = supabaseAdmin.from("team_activity").select("*").eq("team_id", ctx.teamId)
            .not("action", "like", "%/chat/conversations/direct")
            .order("created_at", { ascending: false }).limit(limit + 1);
        if (req.query.memberId) q = q.eq("actor_id", req.query.memberId);
        if (req.query.category) q = q.eq("category", req.query.category);
        if (req.query.before && !Number.isNaN(Date.parse(req.query.before))) q = q.lt("created_at", req.query.before);
        if (req.query.after && !Number.isNaN(Date.parse(req.query.after))) q = q.gt("created_at", req.query.after);

        const { data, error } = await q;
        if (error) throw error;
        const page = (data || []).slice(0, limit);
        const rows = await enrichStoredRows(page, ctx.companyId);
        res.json({
            success: true, hasMore: (data || []).length > limit,
            events: rows.map((r) => ({
                id: r.id, actorId: r.actor_id, actorName: r.actor_name, actorRole: r.actor_role,
                category: r.category, action: r.action, label: r.label,
                entityType: r.entity_type, entityId: r.entity_id, meta: r.meta, createdAt: r.created_at,
            })),
        });
    } catch (e) { serverError(res, e, "getActivity"); }
}

/* ===================== PUBLIC: joining through an invite link ===================== */
async function loadInvite(token) {
    if (!token || typeof token !== "string" || token.length < 32) return { state: "invalid" };
    const { data: inv } = await supabaseAdmin.from("team_invites").select("*").eq("token_hash", hashToken(token)).maybeSingle();
    if (!inv) return { state: "invalid" };
    if (inv.status === "accepted") return { state: "used", inv };
    if (inv.status === "revoked") return { state: "revoked", inv };
    if (inv.status === "expired" || inv.expires_at < new Date().toISOString()) return { state: "expired", inv };
    return { state: "ok", inv };
}
const STATE_MSG = {
    invalid: [404, "This invite link isn't valid."],
    used: [410, "This invite has already been used."],
    revoked: [410, "This invite was cancelled by the team admin."],
    expired: [410, "This invite link has expired. Ask your team admin to send a new one."],
};

export async function getInviteInfo(req, res) {
    try {
        const { state, inv } = await loadInvite(req.params.token);
        if (state !== "ok") { const [s, m] = STATE_MSG[state]; return res.status(s).json({ success: false, code: state, message: m }); }
        const { data: team } = await supabaseAdmin.from("teams").select("owner_id").eq("id", inv.team_id).maybeSingle();
        if (!team) return res.status(404).json({ success: false, code: "invalid", message: STATE_MSG.invalid[1] });
        res.json({
            success: true, companyName: await companyNameOf(team.owner_id),
            channel: inv.channel, maskedValue: maskContact(inv.channel, inv.value), expiresAt: inv.expires_at,
        });
    } catch (e) { serverError(res, e, "getInviteInfo"); }
}

// Validates the OPTIONAL second contact a joiner adds (the channel opposite to the invited one).
// Validates the second contact a joiner must add (the channel opposite to the invited one).
async function resolveExtraContact(inv, raw) {
    const want = inv.channel === "phone" ? "email" : "phone";
    const extra = normalizeContact(raw);
    if (!extra || extra.channel !== want) {
        return { error: { status: 400, message: `Enter a valid ${want === "email" ? "email address" : "10-digit mobile number"}.` } };
    }
    const col = want === "phone" ? "phone" : "email";
    const { data: rows, error } = await supabaseAdmin.from("profiles").select("id")
        .eq(col, extra.value).eq(`${col}_verified`, true).eq("role", "user").is("deleted_at", null).limit(1);
    if (error) throw error;
    if (rows?.length) {
        return { error: { status: 409, message: `This ${want === "email" ? "email" : "mobile number"} is already registered with another account.` } };
    }
    return { extra };
}

export async function requestJoinOtp(req, res) {
    try {
        const { state, inv } = await loadInvite(req.params.token);
        if (state !== "ok") { const [s, m] = STATE_MSG[state]; return res.status(s).json({ success: false, code: state, message: m }); }

        const conflict = await contactConflict({ channel: inv.channel, value: inv.value }, inv.team_id);
        if (conflict) return res.status(409).json({ success: false, code: conflict, message: CONFLICT_MSG(inv.channel)[conflict] });

        const r = await resolveExtraContact(inv, req.body?.extraValue);
        if (r.error) return res.status(r.error.status).json({ success: false, message: r.error.message });
        const extra = r.extra;

        await issueOtp({ purpose: "team_join", channel: inv.channel, value: inv.value });
        await issueOtp({ purpose: "team_join_extra", channel: extra.channel, value: extra.value });

        res.json({
            success: true, channel: inv.channel, maskedValue: maskContact(inv.channel, inv.value),
            extra: { channel: extra.channel, maskedValue: maskContact(extra.channel, extra.value) },
        });
    } catch (e) {
        console.error("[team] join otp failed:", e?.message || e);
        res.status(e?.status || 502).json({ success: false, message: "Couldn't send the code. Try again." });
    }
}

const ACCEPT_ERRORS = {
    INVITE_USED: [410, "This invite has already been used."],
    INVITE_EXPIRED: [410, "This invite link has expired. Ask your team admin to send a new one."],
    INVITE_NOT_FOUND: [404, "This invite link isn't valid."],
    ALREADY_IN_TEAM: [409, "This contact is already part of a team."],
    TEAM_FULL: [400, "This team is full. Ask your team admin to make room."],
};


export async function acceptInvite(req, res) {
    let createdProfileId = null;
    try {
        if (!AUTH_JWT_SECRET) throw new Error("AUTH_JWT_SECRET is not set.");
        const { state, inv } = await loadInvite(req.params.token);
        if (state !== "ok") { const [s, m] = STATE_MSG[state]; return res.status(s).json({ success: false, code: state, message: m }); }

        const name = String(req.body?.name || "").trim().slice(0, 80);
        const otp = String(req.body?.otp || "").trim();
        const extraOtp = String(req.body?.extraOtp || "").trim();
        if (name.length < 2) return res.status(400).json({ success: false, message: "Enter your full name." });
        if (!otp) return res.status(400).json({ success: false, message: "Enter the code we sent you." });

        const r = await resolveExtraContact(inv, req.body?.extraValue);
        if (r.error) return res.status(r.error.status).json({ success: false, message: r.error.message });
        const extra = r.extra;
        if (!extraOtp) {
            return res.status(400).json({ success: false, message: `Enter the code we sent to your ${extra.channel === "email" ? "email" : "mobile number"}.` });
        }

        const result = await checkOtp({ purpose: "team_join", channel: inv.channel, value: inv.value, otp });
        if (!result.ok) return res.status(result.status || 400).json({ success: false, message: result.message });

        const er = await checkOtp({ purpose: "team_join_extra", channel: extra.channel, value: extra.value, otp: extraOtp });
        if (!er.ok) return res.status(er.status || 400).json({ success: false, message: er.message });

        const conflict = await contactConflict({ channel: inv.channel, value: inv.value }, inv.team_id);
        if (conflict) return res.status(409).json({ success: false, code: conflict, message: CONFLICT_MSG(inv.channel)[conflict] });

        const extraCol = extra.channel === "phone" ? "phone" : "email";
        const profilePatch = {
            name, onboarding_step: "team_member",
            [extraCol]: extra.value, [`${extraCol}_verified`]: true,
        };

        const col = inv.channel === "phone" ? "phone" : "email";
        const vcol = `${col}_verified`;
        const findVerified = () => supabaseAdmin.from("profiles").select("id")
            .eq(col, inv.value).eq(vcol, true).eq("role", "user").is("deleted_at", null).maybeSingle();

        let { data: prof } = await findVerified();
        if (prof) {
            const { error } = await supabaseAdmin.from("profiles").update(profilePatch).eq("id", prof.id);
            if (error) throw error;
        } else {
            const { data: created, error } = await supabaseAdmin.from("profiles")
                .insert({ [col]: inv.value, [vcol]: true, role: "user", ...profilePatch })
                .select("id").single();
            if (error) {
                if (error.code !== "23505") throw error;
                ({ data: prof } = await findVerified());
                if (!prof) throw error;
                const { error: upErr } = await supabaseAdmin.from("profiles").update(profilePatch).eq("id", prof.id);
                if (upErr) throw upErr;
            } else { prof = created; createdProfileId = created.id; }
        }

        const { data: joined, error: rpcErr } = await supabaseAdmin
            .rpc("accept_team_invite", { p_invite_id: inv.id, p_user_id: prof.id }).single();
        if (rpcErr) {
            if (createdProfileId) await supabaseAdmin.from("profiles").delete().eq("id", createdProfileId);
            const [s, m] = ACCEPT_ERRORS[(rpcErr.message || "").trim()] || [500, "Couldn't join the team. Please try again."];
            if (s === 500) console.error("[team] accept rpc failed:", rpcErr);
            return res.status(s).json({ success: false, message: m });
        }
        invalidateTeamContext(prof.id);

        const companyName = await companyNameOf(joined.r_owner_id);
        await logActivity({
            teamId: joined.r_team_id, actorId: prof.id, actorRole: "member", category: "team", action: "team.member_joined",
            label: `${name} joined the team`, entityType: "member", entityId: prof.id,
            meta: {
                channel: inv.channel, contact: maskContact(inv.channel, inv.value),
                extraContact: maskContact(extra.channel, extra.value),
            }, ip: ipOf(req),
        });
        notifyUser(joined.r_owner_id, {
            type: "team_member_joined", title: `${name} joined your team`,
            body: `${name} accepted your invite and can now work on behalf of ${companyName}.`, link: "/home",
        }).catch(() => { });

        const token = jwt.sign({ sub: prof.id }, AUTH_JWT_SECRET, { expiresIn: "168h" });
        res.json({ success: true, token, isNewUser: false, companyName });
    } catch (e) {
        if (createdProfileId) await supabaseAdmin.from("profiles").delete().eq("id", createdProfileId).then(() => { }, () => { });
        if (e?.code === "23505") {
            return res.status(409).json({ success: false, message: "That contact was just registered with another account. Use a different one." });
        }
        serverError(res, e, "acceptInvite");
    }
}