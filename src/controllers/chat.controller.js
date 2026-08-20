// controllers/chat.controller.js
import { supabase } from "../config/supabase.js";
import { getIO } from "../socket/io.js";
import { isOnline } from "../socket/chatSocket.js";
import { emitToConversation } from "../socket/emit.js";
import { invalidateParticipants } from "../socket/participantsCache.js";

const MESSAGE_PAGE_SIZE = 30;

// ---- helpers -------------------------------------------------

async function assertParticipant(conversationId, userId) {
    const { data, error } = await supabase
        .from("chat_participants")
        .select("user_id")
        .eq("conversation_id", conversationId)
        .eq("user_id", userId)
        .maybeSingle();
    if (error) throw error;
    return !!data;
}

// derive sent/delivered/read for a message given the OTHER
// participants' watermarks (group-safe: "read" only once every other
// participant's last_read_at has passed the message).
function deriveStatus(message, otherParticipants) {
    if (!otherParticipants.length) return "sent";
    const t = new Date(message.created_at).getTime();
    const allRead = otherParticipants.every((p) => p.last_read_at && new Date(p.last_read_at).getTime() >= t);
    if (allRead) return "read";
    const anyDelivered = otherParticipants.some((p) => p.last_delivered_at && new Date(p.last_delivered_at).getTime() >= t);
    return anyDelivered ? "delivered" : "sent";
}

// ---- conversations --------------------------------------------

export async function listConversations(req, res) {
    const userId = req.user.id;

    const { data: myRows, error: myErr } = await supabase
        .from("chat_participants")
        .select("conversation_id, last_read_at, last_delivered_at")
        .eq("user_id", userId);
    if (myErr) return res.status(500).json({ success: false, message: myErr.message });
    if (!myRows.length) return res.json({ success: true, conversations: [] });

    const convIds = myRows.map((r) => r.conversation_id);

    const { data: convs, error: convErr } = await supabase
        .from("chat_conversations")
        .select("id, is_group, title, direct_user_a, direct_user_b, last_message_preview, last_message_sender_id, last_message_at")
        .in("id", convIds)
        .order("last_message_at", { ascending: false, nullsFirst: false });
    if (convErr) return res.status(500).json({ success: false, message: convErr.message });

    const { data: allParticipants, error: partErr } = await supabase
        .from("chat_participants")
        .select("conversation_id, user_id, last_read_at")
        .in("conversation_id", convIds);
    if (partErr) return res.status(500).json({ success: false, message: partErr.message });

    const otherUserIds = [...new Set(
        convs.flatMap((c) => (c.is_group ? [] : [c.direct_user_a, c.direct_user_b]).filter((id) => id !== userId))
    )];
    const { data: otherProfiles } = otherUserIds.length
        ? await supabase.from("profiles").select("id, name").in("id", otherUserIds)
        : { data: [] };
    const profileById = Object.fromEntries((otherProfiles || []).map((p) => [p.id, p]));

    const myRowById = Object.fromEntries(myRows.map((r) => [r.conversation_id, r]));

    const conversations = convs.map((c) => {
        const mine = myRowById[c.id];
        const unread = c.last_message_at && (!mine.last_read_at || new Date(mine.last_read_at) < new Date(c.last_message_at));
        const otherId = c.is_group ? null : (c.direct_user_a === userId ? c.direct_user_b : c.direct_user_a);
        return {
            id: c.id,
            isGroup: c.is_group,
            title: c.is_group ? c.title : profileById[otherId]?.name || "Unknown user",
            otherUserId: otherId,
            lastMessagePreview: c.last_message_preview,
            lastMessageIsMine: c.last_message_sender_id === userId,
            lastMessageAt: c.last_message_at,
            unread: !!unread,
        };
    });

    res.json({ success: true, conversations });
}

// ---- messages ---------------------------------------------------

export async function listMessages(req, res) {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const before = req.query.before; // ISO timestamp cursor for "load older"

    if (!(await assertParticipant(conversationId, userId))) {
        return res.status(403).json({ success: false, message: "Not a participant." });
    }

    let query = supabase
        .from("chat_messages")
        .select("id, conversation_id, sender_id, body, attachment_url, created_at, edited_at, deleted_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(MESSAGE_PAGE_SIZE);
    if (before) query = query.lt("created_at", before);

    const { data: messages, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    const { data: participants } = await supabase
        .from("chat_participants")
        .select("user_id, last_delivered_at, last_read_at")
        .eq("conversation_id", conversationId);
    const others = (participants || []).filter((p) => p.user_id !== userId);

    const withStatus = messages
        .slice()
        .reverse()
        .map((m) => ({ ...m, status: m.sender_id === userId ? deriveStatus(m, others) : undefined }));

    // controllers/chat.controller.js — listMessages, add this before returning
    const { data: myDeletions } = await supabase.from("chat_message_deletions").select("message_id").eq("user_id", userId);
    const deletedForMeIds = new Set((myDeletions || []).map((d) => d.message_id));
    const visible = messages.filter((m) => !deletedForMeIds.has(m.id));

    res.json({ success: true, messages: withStatus, hasMore: messages.length === MESSAGE_PAGE_SIZE });
}

// ---- creating a conversation must invalidate the cache ----
export async function getOrCreateDirectConversation(req, res) {
    // ...unchanged creation logic from before...
    if (/* newly created */ true) {
        invalidateParticipants(conversationId);
    }
    res.json({ success: true, conversationId });
}

// ---- sendMessage: emit via emitToConversation, not io.to(room) ----
export async function sendMessage(req, res) {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { body, attachmentUrl, clientMessageId } = req.body;

    if (!body?.trim() && !attachmentUrl) return res.status(400).json({ success: false, message: "Empty message." });
    if (!(await assertParticipant(conversationId, userId))) return res.status(403).json({ success: false, message: "Not a participant." });

    const { data: message, error } = await supabase
        .from("chat_messages")
        .insert({ conversation_id: conversationId, sender_id: userId, body: body?.trim() || null, attachment_url: attachmentUrl || null, client_message_id: clientMessageId || null })
        .select("id, conversation_id, sender_id, body, attachment_url, created_at, client_message_id")
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    const preview = body?.trim() ? (body.trim().length > 80 ? body.trim().slice(0, 80) + "…" : body.trim()) : "📎 Attachment";

    await Promise.all([
        supabase.from("chat_conversations").update({ last_message_id: message.id, last_message_preview: preview, last_message_sender_id: userId, last_message_at: message.created_at }).eq("id", conversationId),
        supabase.from("chat_participants").update({ last_read_at: message.created_at, last_delivered_at: message.created_at }).eq("conversation_id", conversationId).eq("user_id", userId),
    ]);

    const payload = { ...message, status: "sent" };
    await emitToConversation(conversationId, "message:new", payload); // includes sender, for multi-device sync

    const { data: recipients } = await supabase.from("chat_participants").select("user_id, is_muted").eq("conversation_id", conversationId).neq("user_id", userId);
    const deliveredTo = (recipients || []).filter((r) => isOnline(r.user_id)).map((r) => r.user_id);
    if (deliveredTo.length) {
        const nowIso = new Date().toISOString();
        await supabase.from("chat_participants").update({ last_delivered_at: nowIso }).eq("conversation_id", conversationId).in("user_id", deliveredTo);
        await emitToConversation(conversationId, "message:status", { conversationId, deliveredAt: nowIso, byUserIds: deliveredTo });
    }

    await emitToConversation(conversationId, "conversation:updated", { conversationId }, { excludeUserId: userId });

    const toNotify = (recipients || []).filter((r) => !r.is_muted);
    const { data: senderProfile } = await supabase.from("profiles").select("name").eq("id", userId).single();
    if (toNotify.length) {
        const { data: inserted } = await supabase.from("notifications").insert(
            toNotify.map((r) => ({ user_id: r.user_id, type: "message", title: senderProfile?.name || "New message", body: preview, link: `/chat/${conversationId}`, read: false }))
        ).select("id, user_id, title, body, link, created_at");
        const io = getIO();
        (inserted || []).forEach((n) => io.to(`user:${n.user_id}`).emit("notification:new", n));
    }

    res.json({ success: true, message: payload });
}

export async function markRead(req, res) {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const now = new Date().toISOString();
    const { error } = await supabase.from("chat_participants").update({ last_read_at: now, last_delivered_at: now }).eq("conversation_id", conversationId).eq("user_id", userId);
    if (error) return res.status(500).json({ success: false, message: error.message });

    // this now reaches the sender NO MATTER what window they have open —
    // that's the whole fix.
    await emitToConversation(conversationId, "message:status", { conversationId, readAt: now, byUserIds: [userId] }, { excludeUserId: userId });
    res.json({ success: true });
}

export async function markDelivered(req, res) {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const now = new Date().toISOString();
    const { error } = await supabase.from("chat_participants").update({ last_delivered_at: now }).eq("conversation_id", conversationId).eq("user_id", userId);
    if (error) return res.status(500).json({ success: false, message: error.message });
    await emitToConversation(conversationId, "message:status", { conversationId, deliveredAt: now, byUserIds: [userId] }, { excludeUserId: userId });
    res.json({ success: true });
}

// ---- delete message: "me" or "everyone" ----
export async function deleteMessage(req, res) {
    const userId = req.user.id;
    const { conversationId, messageId } = req.params;
    const { scope } = req.body; // "me" | "everyone"

    const { data: message, error: fetchErr } = await supabase
        .from("chat_messages").select("id, sender_id, conversation_id").eq("id", messageId).single();
    if (fetchErr || !message || message.conversation_id !== conversationId) {
        return res.status(404).json({ success: false, message: "Message not found." });
    }

    if (scope === "everyone") {
        if (message.sender_id !== userId) {
            return res.status(403).json({ success: false, message: "You can only delete your own messages for everyone." });
        }
        const { error } = await supabase.from("chat_messages").update({ deleted_at: new Date().toISOString(), body: null, attachment_url: null }).eq("id", messageId);
        if (error) return res.status(500).json({ success: false, message: error.message });
        await emitToConversation(conversationId, "message:deleted", { conversationId, messageId, scope: "everyone" });
        return res.json({ success: true, scope: "everyone" });
    }

    // "me" — invisible to everyone else, only affects this user's view/devices
    const { error } = await supabase.from("chat_message_deletions").upsert({ message_id: messageId, user_id: userId });
    if (error) return res.status(500).json({ success: false, message: error.message });
    getIO().to(`user:${userId}`).emit("message:deleted", { conversationId, messageId, scope: "me" }); // syncs their other open tabs/devices
    res.json({ success: true, scope: "me" });
}

// ---- search: name OR their shop's name ----
export async function searchChatUsers(req, res) {
    const q = (req.query.q || "").trim();
    const myId = req.user.id;
    if (q.length < 2) return res.json({ success: true, users: [] });

    const [byName, byShop] = await Promise.all([
        supabase.from("profiles").select("id, name").neq("id", myId).ilike("name", `%${q}%`).limit(10),
        supabase.from("seller_profiles").select("user_id, display_name, shop_slug").neq("user_id", myId).eq("status", "approved").ilike("display_name", `%${q}%`).limit(10),
    ]);

    const shopUserIds = (byShop.data || []).map((s) => s.user_id);
    const { data: shopOwnerProfiles } = shopUserIds.length
        ? await supabase.from("profiles").select("id, name").in("id", shopUserIds)
        : { data: [] };
    const nameByUserId = Object.fromEntries((shopOwnerProfiles || []).map((p) => [p.id, p.name]));

    const merged = new Map();
    (byName.data || []).forEach((u) => merged.set(u.id, { id: u.id, name: u.name, matchedVia: "name" }));
    (byShop.data || []).forEach((s) => {
        merged.set(s.user_id, {
            id: s.user_id,
            name: nameByUserId[s.user_id] || "Unknown user",
            shopName: s.display_name,
            shopSlug: s.shop_slug,
            matchedVia: "shop",
        });
    });

    res.json({ success: true, users: Array.from(merged.values()).slice(0, 12) });
}