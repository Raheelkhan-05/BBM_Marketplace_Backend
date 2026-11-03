// src/services/salesChat.service.js
// Group chat on a sales enquiry: who is in it, who must be told, realtime fan-out, instant WhatsApp, typing.
//
// Model: a message is a normal sales_thread_entries "note" row. The salesperson's own entries have
// author_id = rfq_enquiries.created_by_actor_id; everyone else's are the chat. Participants live in
// sales_thread_participants (last_read_at drives unread counts and the 1-hour reminder).
// Company admins can always open any thread; they become participants when they post or are added.
import { supabaseAdmin as db } from "../config/supabase.js";
import { getIO } from "../socket/io.js";
import { emitToUser } from "./realtimeBroadcast.js";
import { bumpVer } from "./cache.service.js";
import { isUuid } from "./rfqValidation.js";
import { APP_URL, ping } from "./salesThreads.service.js";
import { sendSalesChatWhatsApp } from "./whatsapp.service.js";

const PUSH_GAP_MS = (Number(process.env.SALES_CHAT_PUSH_GAP_MIN) || 30) * 60_000;   // instant WhatsApp: at most one per person per thread per 30 min
const GENERIC = new Set(["", "salesperson", "sales person", "sales", "user", "unnamed", "unknown", "team member"]);
export const realName = (v) => { const s = String(v || "").trim(); return s && !GENERIC.has(s.toLowerCase()) ? s : ""; };
export const firstName = (n) => String(n || "Someone").trim().split(/\s+/)[0];

/* ------------------------------ people ------------------------------ */
export async function namesOf(ids) {
    const uniq = [...new Set((ids || []).filter(Boolean).map(String))];
    const out = new Map();
    if (!uniq.length) return out;
    const { data, error } = await db.from("profiles").select("id, name, email, phone").in("id", uniq);
    if (error) { console.error("[sales chat] names failed:", error.message); return out; }
    for (const p of data || []) out.set(p.id, { name: realName(p.name) || p.email || p.phone || "Teammate", phone: p.phone || null });
    return out;
}

const adminsCache = new Map();
export async function companyAdmins(companyId) {
    const hit = adminsCache.get(companyId);
    if (hit && hit.exp > Date.now()) return hit.ids;
    const ids = [String(companyId)];
    const { data: team } = await db.from("teams").select("id").eq("owner_id", companyId).maybeSingle();
    if (team) {
        const { data } = await db.from("team_members").select("user_id").eq("team_id", team.id).eq("role", "admin");
        (data || []).forEach((m) => ids.push(String(m.user_id)));
    }
    const uniq = [...new Set(ids)];
    if (adminsCache.size > 500) adminsCache.clear();
    adminsCache.set(companyId, { ids: uniq, exp: Date.now() + 60_000 });
    return uniq;
}

async function participantIds(enquiryId) {
    const { data } = await db.from("sales_thread_participants").select("user_id").eq("enquiry_id", enquiryId);
    return (data || []).map((r) => String(r.user_id));
}

// Everyone who may see / hear about this thread right now.
export async function audienceOf(row, companyId) {
    const [parts, admins] = await Promise.all([participantIds(row.id), companyAdmins(companyId)]);
    return new Set([row.created_by_actor_id, ...parts, ...admins].filter(Boolean).map(String));
}

// [{ userId, name, role: salesperson | admin | member, isOwner }], salesperson first.
export async function participantsOf(row, ctx) {
    const parts = await participantIds(row.id);
    const ids = [...new Set([row.created_by_actor_id, ...parts].filter(Boolean).map(String))];
    const roles = new Map();
    if (ctx.teamId && ids.length) {
        const { data } = await db.from("team_members").select("user_id, role").eq("team_id", ctx.teamId).in("user_id", ids);
        (data || []).forEach((m) => roles.set(String(m.user_id), m.role));
    }
    const names = await namesOf(ids);
    const rank = { salesperson: 0, admin: 1, member: 2 };
    return ids.map((id) => ({
        userId: id,
        name: names.get(id)?.name || "Teammate",
        role: id === String(row.created_by_actor_id) ? "salesperson" : (id === String(ctx.companyId) || roles.get(id) === "admin") ? "admin" : "member",
        isOwner: id === String(ctx.companyId),
    })).sort((a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name));
}

// Inserts missing participants. Returns the ids that were newly added.
export async function ensureParticipants(row, extra = [], addedBy = null) {
    const ids = [...new Set([row.created_by_actor_id, ...extra].filter(Boolean).map(String))];
    const have = new Set(await participantIds(row.id));
    const missing = ids.filter((i) => !have.has(i));
    if (missing.length) {
        const { error } = await db.from("sales_thread_participants")
            .upsert(missing.map((user_id) => ({ enquiry_id: row.id, user_id, added_by: addedBy })), { onConflict: "enquiry_id,user_id", ignoreDuplicates: true });
        if (error) console.error("[sales chat] ensure participants failed:", error.message);
    }
    return missing;
}

// Only people already in the chat can be tagged.
export async function cleanMentions(raw, row, senderId) {
    if (!Array.isArray(raw)) return [];
    const ids = [...new Set(raw.filter(isUuid).map(String))].filter((i) => i !== String(senderId)).slice(0, 10);
    if (!ids.length) return [];
    const ok = new Set(await participantIds(row.id));
    if (row.created_by_actor_id) ok.add(String(row.created_by_actor_id));
    return ids.filter((i) => ok.has(i));
}

export async function markRead(enquiryId, userId) {
    const { data } = await db.from("sales_thread_participants")
        .update({ last_read_at: new Date().toISOString() }).eq("enquiry_id", enquiryId).eq("user_id", userId).select("user_id");
    if (data?.length) emitToUser(userId, "salesChat:read", { threadId: enquiryId });   // other tabs / badges
    return !!data?.length;
}

/* ------------------------------ realtime ------------------------------ */
const metaCache = new Map();   // threadId -> { audience:Set, exp }
export const forgetThread = (id) => metaCache.delete(id);

export async function threadAudience(threadId) {
    const hit = metaCache.get(threadId);
    if (hit && hit.exp > Date.now()) return hit.audience;
    const { data: row } = await db.from("rfq_enquiries").select("id, buyer_id, created_by_actor_id")
        .eq("id", threadId).eq("source", "sales").maybeSingle();
    if (!row) return null;
    const audience = await audienceOf(row, row.buyer_id);
    if (metaCache.size > 2000) metaCache.clear();
    metaCache.set(threadId, { audience, exp: Date.now() + 30_000 });
    return audience;
}

export async function emitParticipantsChanged(row, companyId, extraUsers = []) {
    forgetThread(row.id);
    const audience = await audienceOf(row, companyId);
    extraUsers.forEach((u) => audience.add(String(u)));
    for (const uid of audience) emitToUser(uid, "salesChat:participants", { threadId: row.id });
}

// Typing indicators. Client: socket.emit("salesChat:typing", { threadId, typing }).
export function registerSalesChatSocket(io) {
    io.on("connection", (socket) => {
        const uid = socket.userId && String(socket.userId);
        if (!uid) return;
        socket.join(`user:${uid}`);          // idempotent: the room every notification already uses
        const lastAt = new Map();
        socket.on("salesChat:typing", async (p) => {
            try {
                const threadId = p?.threadId;
                if (!isUuid(threadId)) return;
                const on = p.typing !== false;
                const now = Date.now();
                if (on && now - (lastAt.get(threadId) || 0) < 1200) return;
                lastAt.set(threadId, on ? now : 0);
                const audience = await threadAudience(threadId);
                if (!audience || !audience.has(uid) || audience.size < 2) return;
                const name = firstName((await namesOf([uid])).get(uid)?.name);
                // .except(): team members share the company room, so the typer's own socket must be excluded explicitly
                const rooms = [...audience].filter((r) => r !== uid).map((r) => `user:${r}`);
                if (rooms.length) io.to(rooms).except(`user:${uid}`).emit("salesChat:typing", { threadId, userId: uid, name, typing: on });
            } catch { /* typing is best effort */ }
        });
    });
}

/* ------------------------------ WhatsApp ------------------------------ */
const linkFor = (row, uid) => (String(uid) === String(row.created_by_actor_id)
    ? `${APP_URL}/sales/enquiries/${row.id}` : `${APP_URL}/home?enquiry=${row.id}`);

async function isOnline(uid) {
    try { return (await getIO().in(`user:${uid}`).fetchSockets()).length > 0; } catch { return false; }
}

// First message to someone who is offline: one WhatsApp, then silence for PUSH_GAP_MS (the 1-hour reminder covers the rest).
async function pushInstant({ row, recipients, senderName, preview }) {
    const cutoff = new Date(Date.now() - PUSH_GAP_MS).toISOString();
    for (const uid of recipients) {
        try {
            if (await isOnline(uid)) continue;
            const { data } = await db.from("sales_thread_participants").update({ last_pushed_at: new Date().toISOString() })
                .eq("enquiry_id", row.id).eq("user_id", uid)
                .or(`last_pushed_at.is.null,last_pushed_at.lt.${cutoff}`).select("user_id");
            if (!data?.length) continue;
            const me = (await namesOf([uid])).get(uid);
            if (!me?.phone) continue;
            await sendSalesChatWhatsApp({
                to: me.phone, name: firstName(me.name), kind: "new", customer: row.customer_name || "a customer",
                product: row.product_name || "", from: senderName, preview, link: linkFor(row, uid),
            });
        } catch (e) { console.error("[sales chat] instant WhatsApp failed:", e?.message || e); }
    }
}

export async function notifyAdded({ row, userId, byName }) {
    try {
        const me = (await namesOf([userId])).get(userId);
        if (!me?.phone) return;
        await sendSalesChatWhatsApp({
            to: me.phone, name: firstName(me.name), kind: "added", customer: row.customer_name || "a customer",
            product: row.product_name || "", from: byName, link: linkFor(row, userId),
        });
    } catch (e) { console.error("[sales chat] added WhatsApp failed:", e?.message || e); }
}

export const reminderLink = linkFor;

/* ------------------------------ after a message is saved ------------------------------ */
// touch:true  -> also bumps last_activity / preview (used for teammates' messages; the salesperson's own
//                addEntry already does that through its own touch()).
export async function afterMessage({ row, companyId, entry, senderId, senderName, preview, touch = true }) {
    const now = new Date().toISOString();
    senderId = String(senderId);
    const added = await ensureParticipants(row, [senderId], senderId);

    const jobs = [db.from("sales_thread_participants").update({ last_read_at: now }).eq("enquiry_id", row.id).eq("user_id", senderId)];
    if (touch) {
        jobs.push(db.from("rfq_enquiries").update({
            last_activity_at: now, last_entry_preview: `${firstName(senderName)}: ${preview}`.slice(0, 120),
        }).eq("id", row.id));
    }
    await Promise.all(jobs);
    await bumpVer(`sa:${row.created_by_actor_id}`, `st:${row.id}`);
    ping([companyId, row.created_by_actor_id], { enquiryId: row.id });

    if (added.some((i) => i !== String(row.created_by_actor_id))) await emitParticipantsChanged(row, companyId);
    const audience = await audienceOf(row, companyId);
    const payload = { threadId: row.id, entry, senderId, senderName, preview };
    for (const uid of audience) if (uid !== senderId) emitToUser(uid, "salesChat:message", payload);

    const recipients = (await participantIds(row.id)).filter((i) => i !== senderId);
    pushInstant({ row, recipients, senderName, preview }).catch(() => { /* logged inside */ });
}