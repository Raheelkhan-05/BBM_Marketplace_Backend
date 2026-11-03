// src/controllers/salesChat.controller.js
// Enquiry group chat. One set of endpoints for the salesperson, the team admin and added team members.
// Access: the thread's salesperson, any company admin, or a participant. Nobody else (other salespeople included).
import { randomUUID } from "node:crypto";
import { supabaseAdmin as db } from "../config/supabase.js";
import { getTeamContext } from "../services/team.service.js";
import { isUuid } from "../services/rfqValidation.js";
import { BUCKET, str, threadDto, hydrateEntries, clipPreview } from "../services/salesThreads.service.js";
import {
    namesOf, participantsOf, ensureParticipants, cleanMentions, afterMessage, markRead,
    audienceOf, emitParticipantsChanged, notifyAdded, firstName,
} from "../services/salesChat.service.js";
import { emitToUser } from "../services/realtimeBroadcast.js";

const PAGE = 30, PAGE_MAX = 50, MAX_FILES = 10, MAX_BYTES = 15 * 1024 * 1024, BODY_MAX = 4000;
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "pdf", "doc", "docx", "xls", "xlsx", "csv", "txt", "ppt", "pptx"]);

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const oops = (res, e, where) => { console.error(`[sales chat] ${where}:`, e?.message || e); return fail(res, 500, "Something went wrong. Please try again."); };
const isoOf = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : new Date(t).toISOString(); };

// Resolves the caller + thread, or answers 404 and returns null.
async function access(req, res) {
    const actorId = String(req.actor?.id || req.user.id);
    const { id } = req.params;
    if (!isUuid(id)) { fail(res, 404, "Enquiry not found."); return null; }
    const ctx = await getTeamContext(actorId);
    const { data: row, error } = await db.from("rfq_enquiries").select("*")
        .eq("id", id).eq("source", "sales").eq("buyer_id", ctx.companyId).maybeSingle();
    if (error) throw error;
    const isCreator = !!row && String(row.created_by_actor_id) === actorId;
    if (row && !ctx.isAdmin && !isCreator) {
        const { data: p, error: pErr } = await db.from("sales_thread_participants").select("user_id")
            .eq("enquiry_id", id).eq("user_id", actorId).maybeSingle();
        if (pErr) throw pErr;
        if (!p) { fail(res, 404, "Enquiry not found."); return null; }
    }
    if (!row) { fail(res, 404, "Enquiry not found."); return null; }
    return { actorId, ctx, row, isAdmin: !!ctx.isAdmin, isCreator };
}

const threadView = async (row, quotes) => {
    const names = await namesOf([row.created_by_actor_id]);
    return {
        ...threadDto(row, { quotesCount: quotes }),
        outcome: row.sales_outcome || null,
        reminderAt: row.reminder_at || null,
        salespersonName: names.get(String(row.created_by_actor_id))?.name || row.created_by_actor_name || "",
    };
};

// GET /api/sales-chat/threads/:id?limit&before&beforeId
export async function getThread(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const a = await access(req, res); if (!a) return;
        const { row, ctx, actorId, isAdmin, isCreator } = a;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || PAGE, 1), PAGE_MAX);
        const before = req.query.before ? isoOf(req.query.before) : null;
        const beforeId = isUuid(req.query.beforeId) ? String(req.query.beforeId) : "";
        if (req.query.before && !before) return fail(res, 400, "Invalid cursor.");

        let q = db.from("sales_thread_entries").select("*").eq("enquiry_id", row.id)
            .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
        if (before) q = beforeId ? q.or(`created_at.lt.${before},and(created_at.eq.${before},id.lt.${beforeId})`) : q.lt("created_at", before);

        const [list, qc, participants] = await Promise.all([
            q,
            db.from("sales_quotes").select("id", { count: "exact", head: true }).eq("enquiry_id", row.id),
            participantsOf(row, ctx),
        ]);
        if (list.error) throw list.error;
        const data = list.data || [];
        res.json({
            success: true, me: actorId, canManage: isAdmin || isCreator,
            thread: await threadView(row, qc.count || 0), participants,
            entries: await hydrateEntries(data.slice(0, limit).reverse()), hasOlder: data.length > limit,
        });
    } catch (e) { oops(res, e, "getThread"); }
}

// GET /threads/:id/participants (light call for the salesperson page)
export async function getParticipants(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const a = await access(req, res); if (!a) return;
        res.json({ success: true, me: a.actorId, canManage: a.isAdmin || a.isCreator, participants: await participantsOf(a.row, a.ctx) });
    } catch (e) { oops(res, e, "getParticipants"); }
}

function cleanAttachments(list, enquiryId) {
    if (list == null) return [];
    if (!Array.isArray(list) || list.length > MAX_FILES) return null;
    const out = [];
    for (const f of list) {
        const path = typeof f?.path === "string" ? f.path : "";
        if (!path.startsWith(`${enquiryId}/`) || path.includes("..") || path.length > 200) return null;
        out.push({ path, name: str(f.name, 150) || "file", type: str(f.type, 100), size: Math.max(0, Math.min(Number(f.size) || 0, MAX_BYTES)) });
    }
    return out;
}

// POST /threads/:id/messages { body, mentions[], attachments[] }
export async function postMessage(req, res) {
    try {
        const a = await access(req, res); if (!a) return;
        const { row, ctx, actorId } = a;
        if (row.status === "closed") return fail(res, 409, "This enquiry is closed. The salesperson can reopen it to continue the chat.");

        const body = str(req.body?.body, BODY_MAX);
        const attachments = cleanAttachments(req.body?.attachments, row.id);
        if (attachments === null) return fail(res, 400, "Attachments are invalid.");
        if (!body && !attachments.length) return fail(res, 400, "Write a message or attach a file.");

        const name = (await namesOf([actorId])).get(actorId)?.name || "Teammate";
        const mentions = await cleanMentions(req.body?.mentions, row, actorId);
        const { data, error } = await db.from("sales_thread_entries")
            .insert({ enquiry_id: row.id, author_id: actorId, author_name: name, kind: "note", body, attachments, mentions })
            .select("*").single();
        if (error) throw error;

        const [entry] = await hydrateEntries([data]);
        await afterMessage({
            row, companyId: ctx.companyId, entry, senderId: actorId, senderName: name,
            preview: clipPreview(body, attachments.length), touch: true,
        });
        res.json({ success: true, entry });
    } catch (e) { oops(res, e, "postMessage"); }
}

// POST /threads/:id/read
export async function markThreadRead(req, res) {
    try {
        const a = await access(req, res); if (!a) return;
        await markRead(a.row.id, a.actorId);
        res.json({ success: true });
    } catch (e) { oops(res, e, "markRead"); }
}

// GET /threads/:id/candidates  (admins and the salesperson: team admins / members who can still be added)
export async function getCandidates(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const a = await access(req, res); if (!a) return;
        if (!a.isAdmin && !a.isCreator) return fail(res, 403, "Only the salesperson or an admin can add people.");
        const { row, ctx } = a;
        const ids = new Set([String(ctx.companyId)]);
        const roles = new Map();
        if (ctx.teamId) {
            const { data } = await db.from("team_members").select("user_id, role").eq("team_id", ctx.teamId).neq("role", "salesperson");
            (data || []).forEach((m) => { ids.add(String(m.user_id)); roles.set(String(m.user_id), m.role); });
        }
        const inChat = new Set((await participantsOf(row, ctx)).map((p) => p.userId));
        const free = [...ids].filter((i) => !inChat.has(i));
        const names = await namesOf(free);
        res.json({
            success: true,
            candidates: free.map((id) => ({
                userId: id, name: names.get(id)?.name || "Teammate", isOwner: id === String(ctx.companyId),
                role: id === String(ctx.companyId) || roles.get(id) === "admin" ? "admin" : "member",
            })).sort((x, y) => x.name.localeCompare(y.name)),
        });
    } catch (e) { oops(res, e, "getCandidates"); }
}

async function systemLine(row, actorId, actorName, body) {
    const { data, error } = await db.from("sales_thread_entries")
        .insert({ enquiry_id: row.id, author_id: actorId, author_name: actorName, kind: "system", body }).select("*").single();
    if (error) throw error;
    const [entry] = await hydrateEntries([data]);
    return entry;
}

// POST /threads/:id/participants { userId }
export async function addParticipant(req, res) {
    try {
        const a = await access(req, res); if (!a) return;
        if (!a.isAdmin && !a.isCreator) return fail(res, 403, "Only the salesperson or an admin can add people.");
        const { row, ctx, actorId } = a;
        const userId = String(req.body?.userId || "");
        if (!isUuid(userId)) return fail(res, 400, "Choose a teammate to add.");

        let ok = userId === String(ctx.companyId);
        if (!ok && ctx.teamId) {
            const { data } = await db.from("team_members").select("role").eq("team_id", ctx.teamId).eq("user_id", userId).maybeSingle();
            ok = !!data && data.role !== "salesperson";
        }
        if (!ok) return fail(res, 400, "This person can't be added to the chat.");

        const { error } = await db.from("sales_thread_participants").insert({ enquiry_id: row.id, user_id: userId, added_by: actorId });
        if (error) return error.code === "23505" ? fail(res, 409, "Already in this chat.") : oops(res, error, "addParticipant");

        const names = await namesOf([actorId, userId]);
        const by = names.get(actorId)?.name || "Someone", who = names.get(userId)?.name || "a teammate";
        const entry = await systemLine(row, actorId, by, `${firstName(by)} added ${who} to the chat`);
        await emitParticipantsChanged(row, ctx.companyId, [userId]);
        const audience = await audienceOf(row, ctx.companyId);
        for (const uid of audience) if (uid !== actorId) emitToUser(uid, "salesChat:message", { threadId: row.id, entry, senderId: actorId, senderName: by, preview: "" });

        notifyAdded({ row, userId, byName: by });
        res.json({ success: true, participants: await participantsOf(row, ctx), entry });
    } catch (e) { oops(res, e, "addParticipant"); }
}

// DELETE /threads/:id/participants/:userId  (admin / salesperson removes anyone but the salesperson; anyone can leave)
export async function removeParticipant(req, res) {
    try {
        const a = await access(req, res); if (!a) return;
        const { row, ctx, actorId } = a;
        const target = String(req.params.userId || "");
        if (!isUuid(target)) return fail(res, 404, "Person not found.");
        if (target === String(row.created_by_actor_id)) return fail(res, 400, "The salesperson can't be removed from their own enquiry.");
        if (target !== actorId && !a.isAdmin && !a.isCreator) return fail(res, 403, "Only the salesperson or an admin can remove people.");

        const { data, error } = await db.from("sales_thread_participants").delete()
            .eq("enquiry_id", row.id).eq("user_id", target).select("user_id");
        if (error) throw error;
        if (!data?.length) return fail(res, 404, "Person not found.");

        const names = await namesOf([actorId, target]);
        const by = names.get(actorId)?.name || "Someone", who = names.get(target)?.name || "a teammate";
        const entry = await systemLine(row, actorId, by, target === actorId ? `${who} left the chat` : `${firstName(by)} removed ${who} from the chat`);
        await emitParticipantsChanged(row, ctx.companyId, [target]);
        const audience = await audienceOf(row, ctx.companyId);
        for (const uid of audience) if (uid !== actorId) emitToUser(uid, "salesChat:message", { threadId: row.id, entry, senderId: actorId, senderName: by, preview: "" });
        res.json({ success: true, participants: await participantsOf(row, ctx), entry });
    } catch (e) { oops(res, e, "removeParticipant"); }
}

// POST /threads/:id/attachments/sign { name, type, size }
export async function signAttachment(req, res) {
    try {
        const a = await access(req, res); if (!a) return;
        const name = str(req.body?.name, 150), size = Number(req.body?.size);
        const ext = (name.split(".").pop() || "").toLowerCase();
        if (!name || !ALLOWED_EXT.has(ext)) return fail(res, 400, "This file type isn't supported. Use photos, PDF, Word, Excel, PowerPoint, CSV or text files.");
        if (!(size > 0) || size > MAX_BYTES) return fail(res, 400, "Files can be up to 15 MB.");
        const path = `${a.row.id}/${randomUUID()}.${ext}`;
        const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
        if (error) throw error;
        res.json({ success: true, uploadUrl: data.signedUrl, path });
    } catch (e) { oops(res, e, "signAttachment"); }
}

// GET /unread -> { total, byThread: { [id]: { unread, mentions } }, threads }
export async function getUnread(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const actorId = String(req.actor?.id || req.user.id);
        const [u, c] = await Promise.all([
            db.rpc("sales_chat_unread", { p_user: actorId }),
            db.from("sales_thread_participants").select("enquiry_id", { count: "exact", head: true }).eq("user_id", actorId),
        ]);
        if (u.error) throw u.error;
        const byThread = {};
        let total = 0;
        for (const r of u.data || []) { byThread[r.n_enquiry_id] = { unread: r.n_unread, mentions: r.n_mentions }; total += r.n_unread; }
        res.json({ success: true, total, byThread, threads: c.count || 0 });
    } catch (e) { oops(res, e, "getUnread"); }
}

// GET /threads  (the enquiries I am in; this is the team member's "Enquiries" tab)
export async function listInbox(req, res) {
    try {
        res.set("Cache-Control", "no-store");
        const actorId = String(req.actor?.id || req.user.id);
        const ctx = await getTeamContext(actorId);
        const { data: mine, error } = await db.from("sales_thread_participants").select("enquiry_id").eq("user_id", actorId).limit(200);
        if (error) throw error;
        const ids = (mine || []).map((m) => m.enquiry_id);
        if (!ids.length) return res.json({ success: true, items: [] });

        const [rows, unread] = await Promise.all([
            db.from("rfq_enquiries").select("*").in("id", ids).eq("source", "sales").eq("buyer_id", ctx.companyId)
                .order("last_activity_at", { ascending: false }).limit(60),
            db.rpc("sales_chat_unread", { p_user: actorId }),
        ]);
        if (rows.error) throw rows.error;
        const un = new Map((unread.data || []).map((r) => [r.n_enquiry_id, r]));
        const names = await namesOf((rows.data || []).map((r) => r.created_by_actor_id));
        res.json({
            success: true,
            items: (rows.data || []).map((r) => ({
                ...threadDto(r), outcome: r.sales_outcome || null,
                salespersonName: names.get(String(r.created_by_actor_id))?.name || r.created_by_actor_name || "",
                unread: un.get(r.id)?.n_unread || 0, mentions: un.get(r.id)?.n_mentions || 0,
            })),
        });
    } catch (e) { oops(res, e, "listInbox"); }
}

export { ensureParticipants };