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

// Returns the seller_profiles row (if any) for a user_id, deleted_at
// included — used to gate message-sending, not to hide the conversation.
// A user can be a seller and be soft-deleted while still owning history
// buyers need to see, so this is intentionally a lookup, not a filter.
async function getSellerDeletionStatus(userId) {
    const { data } = await supabase
        .from("seller_profiles")
        .select("user_id, deleted_at")
        .eq("user_id", userId)
        .maybeSingle();
    return { isSeller: !!data, isDeleted: !!data?.deleted_at };
}

// For a 1:1 conversation, returns the other participant's user_id.
// Groups have no single "other" party, so this only applies to direct chats.
async function getOtherParticipantId(conversationId, userId) {
    const { data } = await supabase
        .from("chat_conversations")
        .select("is_group, direct_user_a, direct_user_b")
        .eq("id", conversationId)
        .maybeSingle();
    if (!data || data.is_group) return null;
    return data.direct_user_a === userId ? data.direct_user_b : data.direct_user_a;
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

    const otherUserIds = [...new Set(
        convs.flatMap((c) => (c.is_group ? [] : [c.direct_user_a, c.direct_user_b]).filter((id) => id !== userId))
    )];

    // IMPORTANT: no `.is("deleted_at", null)` filter on the seller lookup —
    // unlike the browse/search paths, a chat with a since-deleted seller still
    // needs to render (shop name intact) so the buyer's message history isn't
    // wiped or replaced with "Unknown seller". We fetch deleted_at instead
    // so the UI can show the name AND flag it as deleted.
    //
    // Unread counts and seller profiles are independent, so they run in
    // parallel. Unread counting happens in the database (chat_unread_counts
    // SQL function) instead of downloading every received message.
    const [{ data: unreadRows }, { data: otherSellerProfiles }] = await Promise.all([
        supabase.rpc("chat_unread_counts", { p_user_id: userId }),
        otherUserIds.length
            ? supabase.from("seller_profiles").select("user_id, display_name, logo_url, deleted_at").in("user_id", otherUserIds)
            : Promise.resolve({ data: [] }),
    ]);

    const unreadCountById = Object.fromEntries((unreadRows || []).map((r) => [r.conversation_id, Number(r.unread_count)]));
    const shopById = Object.fromEntries((otherSellerProfiles || []).map((p) => [p.user_id, p]));

    const conversations = convs.map((c) => {
        const otherId = c.is_group ? null : (c.direct_user_a === userId ? c.direct_user_b : c.direct_user_a);
        const unreadCount = unreadCountById[c.id] || 0;
        const otherShop = c.is_group ? null : shopById[otherId];
        return {
            id: c.id,
            isGroup: c.is_group,
            title: c.is_group ? c.title : undefined,
            otherShopName: c.is_group ? undefined : (otherShop?.display_name || "Unknown seller"),
            otherShopLogo: c.is_group ? undefined : (otherShop?.logo_url || null),
            otherUserId: otherId,
            otherIsDeletedSeller: c.is_group ? false : !!otherShop?.deleted_at,
            lastMessagePreview: c.last_message_preview,
            lastMessageIsMine: c.last_message_sender_id === userId,
            lastMessageAt: c.last_message_at,
            unreadCount,
            unread: unreadCount > 0,
        };
    });

    res.json({ success: true, conversations });
}

// ---- messages ---------------------------------------------------

export async function listMessages(req, res) {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const before = req.query.before; // ISO timestamp cursor for "load older"

    let msgQuery = supabase
        .from("chat_messages")
        .select("id, conversation_id, sender_id, body, attachment_url, created_at, edited_at, deleted_at, client_message_id, message_type, metadata")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(MESSAGE_PAGE_SIZE);
    if (before) msgQuery = msgQuery.lt("created_at", before);

    // messages + participants in parallel (used to be 5 sequential queries)
    const [{ data: rows, error }, { data: participants }] = await Promise.all([
        msgQuery,
        supabase
            .from("chat_participants")
            .select("user_id, last_delivered_at, last_read_at")
            .eq("conversation_id", conversationId),
    ]);
    if (error) return res.status(500).json({ success: false, message: error.message });

    // participant check still happens before anything is returned
    if (!(participants || []).some((p) => p.user_id === userId)) {
        return res.status(403).json({ success: false, message: "Not a participant." });
    }
    const others = participants.filter((p) => p.user_id !== userId);

    // Only look up deletions for the messages actually in this page (used to
    // load every deletion the user ever made), and check the seller's
    // deleted status at the same time.
    const [{ data: myDeletions }, deletion] = await Promise.all([
        rows.length
            ? supabase
                .from("chat_message_deletions")
                .select("message_id")
                .eq("user_id", userId)
                .in("message_id", rows.map((r) => r.id))
            : Promise.resolve({ data: [] }),
        others.length === 1 ? getSellerDeletionStatus(others[0].user_id) : Promise.resolve({ isDeleted: false }),
    ]);
    const deletedForMeIds = new Set((myDeletions || []).map((d) => d.message_id));

    // Tells the client whether sending is currently allowed in this
    // conversation, so the composer can disable itself proactively.
    // Only meaningful for 1:1 chats.
    const canSend = !deletion.isDeleted;

    const hasMore = rows.length === MESSAGE_PAGE_SIZE;
    const oldestInPage = rows.length ? rows[rows.length - 1].created_at : null;

    const messages = rows
        .filter((m) => !deletedForMeIds.has(m.id))
        .slice()
        .reverse()
        .map((m) => ({ ...m, status: m.sender_id === userId ? deriveStatus(m, others) : undefined }));

    const otherWatermarks = others.length === 1
        ? { deliveredAt: others[0].last_delivered_at, readAt: others[0].last_read_at }
        : null;

    res.json({ success: true, messages, hasMore, oldestCursor: oldestInPage, otherWatermarks, canSend });
}

// ---- creating/finding a 1:1 conversation ----
export async function getOrCreateDirectConversation(req, res) {
    const userId = req.user.id;
    const { otherUserId } = req.body;
    if (!otherUserId || otherUserId === userId) {
        return res.status(400).json({ success: false, message: "Invalid recipient." });
    }

    // Can't start a fresh conversation with a seller who's been deleted —
    // existing threads still open (see listConversations), this only
    // blocks NEW ones.
    const { isDeleted } = await getSellerDeletionStatus(otherUserId);
    if (isDeleted) {
        return res.status(403).json({ success: false, code: "SELLER_DELETED", message: "This seller's account is no longer active." });
    }

    const [a, b] = [userId, otherUserId].sort();

    const { data: existing, error: findErr } = await supabase
        .from("chat_conversations")
        .select("id")
        .eq("is_group", false)
        .eq("direct_user_a", a)
        .eq("direct_user_b", b)
        .maybeSingle();
    if (findErr) return res.status(500).json({ success: false, message: findErr.message });

    if (existing) {
        return res.json({ success: true, conversationId: existing.id });
    }

    const { data: created, error: createErr } = await supabase
        .from("chat_conversations")
        .insert({ is_group: false, direct_user_a: a, direct_user_b: b })
        .select("id")
        .single();
    if (createErr) return res.status(500).json({ success: false, message: createErr.message });

    const { error: partErr } = await supabase
        .from("chat_participants")
        .insert([
            { conversation_id: created.id, user_id: a },
            { conversation_id: created.id, user_id: b },
        ]);
    if (partErr) return res.status(500).json({ success: false, message: partErr.message });

    invalidateParticipants(created.id);
    res.json({ success: true, conversationId: created.id });
}

export async function sendMessage(req, res) {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { body, attachmentUrl, clientMessageId } = req.body;

    if (!body?.trim() && !attachmentUrl) return res.status(400).json({ success: false, message: "Empty message." });

    const [isParticipant, otherUserId] = await Promise.all([
        assertParticipant(conversationId, userId),
        getOtherParticipantId(conversationId, userId),
    ]);
    if (!isParticipant) return res.status(403).json({ success: false, message: "Not a participant." });

    if (otherUserId) {
        // Block sending when either side is a deleted seller — one query
        // instead of two.
        const { data: deletedRows } = await supabase
            .from("seller_profiles")
            .select("user_id")
            .in("user_id", [userId, otherUserId])
            .not("deleted_at", "is", null);
        if (deletedRows?.length) {
            return res.status(403).json({
                success: false,
                code: "SELLER_DELETED",
                message: "This seller's account has been deleted. You can no longer send messages in this conversation.",
            });
        }
    }

    const { data: message, error } = await supabase
        .from("chat_messages")
        .insert({ conversation_id: conversationId, sender_id: userId, body: body?.trim() || null, attachment_url: attachmentUrl || null, client_message_id: clientMessageId || null })
        .select("id, conversation_id, sender_id, body, attachment_url, created_at, client_message_id")
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    const payload = { ...message, status: "sent" };

    // Fan out to the other person immediately, answer the sender immediately.
    emitToConversation(conversationId, "message:new", payload).catch((e) => console.error("[chat] emit failed:", e.message));
    res.json({ success: true, message: payload });

    // Everything else happens after the response.
    postSendTasks({ userId, conversationId, message }).catch((e) => console.error("[chat] post-send failed:", e.message));
}

async function postSendTasks({ userId, conversationId, message }) {
    const body = message.body;
    const preview = body ? (body.length > 80 ? body.slice(0, 80) + "…" : body) : "📎 Attachment";

    const [, , { data: recipients }, { data: senderShop }, { data: senderProfile }] = await Promise.all([
        supabase.from("chat_conversations").update({ last_message_id: message.id, last_message_preview: preview, last_message_sender_id: userId, last_message_at: message.created_at }).eq("id", conversationId),
        supabase.from("chat_participants").update({ last_read_at: message.created_at, last_delivered_at: message.created_at }).eq("conversation_id", conversationId).eq("user_id", userId),
        supabase.from("chat_participants").select("user_id, is_muted").eq("conversation_id", conversationId).neq("user_id", userId),
        supabase.from("seller_profiles").select("display_name").eq("user_id", userId).is("deleted_at", null).maybeSingle(),
        supabase.from("profiles").select("name").eq("id", userId).single(),
    ]);

    await emitToConversation(conversationId, "conversation:updated", { conversationId }, { excludeUserId: userId });

    const deliveredTo = (recipients || []).filter((r) => isOnline(r.user_id)).map((r) => r.user_id);
    if (deliveredTo.length) {
        const { data: dRow, error: dErr } = await supabase
            .rpc("mark_participants_delivered_for_conversation", { p_conversation_id: conversationId, p_user_ids: deliveredTo })
            .single();
        if (dErr) console.error("[chat] delivered-on-send update failed:", dErr.message);
        else await emitToConversation(conversationId, "message:status", { conversationId, deliveredAt: dRow.delivered_at, byUserIds: deliveredTo });
    }

    const toNotify = (recipients || []).filter((r) => !r.is_muted);
    if (toNotify.length) {
        const title = senderShop?.display_name || senderProfile?.name || "New message";
        const { data: inserted } = await supabase
            .from("notifications")
            .insert(toNotify.map((r) => ({ user_id: r.user_id, type: "message", title, body: preview, link: `/chat/${conversationId}`, read: false })))
            .select("id, user_id, title, body, link, created_at");
        const io = getIO();
        (inserted || []).forEach((n) => io.to(`user:${n.user_id}`).emit("notification:new", n));
    }
}

export async function markRead(req, res) {
    const userId = req.user.id;
    const { conversationId } = req.params;

    const { data, error } = await supabase
        .rpc("mark_participant_read", { p_conversation_id: conversationId, p_user_id: userId })
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    await emitToConversation(conversationId, "message:status",
        { conversationId, readAt: data.last_read_at, byUserIds: [userId] },
        { excludeUserId: userId });
    res.json({ success: true });
}

export async function markDelivered(req, res) {
    const userId = req.user.id;
    const { conversationId } = req.params;

    const { data, error } = await supabase
        .rpc("mark_participant_delivered", { p_conversation_id: conversationId, p_user_id: userId })
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    await emitToConversation(conversationId, "message:status",
        { conversationId, deliveredAt: data.last_delivered_at, byUserIds: [userId] },
        { excludeUserId: userId });
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

    const { error } = await supabase.from("chat_message_deletions").upsert({ message_id: messageId, user_id: userId });
    if (error) return res.status(500).json({ success: false, message: error.message });
    getIO().to(`user:${userId}`).emit("message:deleted", { conversationId, messageId, scope: "me" });
    res.json({ success: true, scope: "me" });
}

// ---- search: approved sellers by shop name only ----
export async function searchChatUsers(req, res) {
    const q = (req.query.q || "").trim();
    const myId = req.user.id;
    if (q.length < 2) return res.json({ success: true, users: [] });

    const { data: byShop, error } = await supabase
        .from("seller_profiles")
        .select("user_id, display_name")
        .eq("status", "approved")
        .neq("user_id", myId)
        .is("deleted_at", null)
        .ilike("display_name", `%${q}%`)
        .limit(12);
    if (error) return res.status(500).json({ success: false, message: error.message });

    res.json({
        success: true,
        users: (byShop || []).map((s) => ({ id: s.user_id, shopName: s.display_name })),
    });
}

// ---- list all approved sellers, for the buyer's "start a chat" sidebar ----
export async function listApprovedSellers(req, res) {
    const myId = req.user.id;

    const { data: sellers, error } = await supabase
        .from("seller_profiles")
        .select("user_id, display_name, logo_url")
        .eq("status", "approved")
        .neq("user_id", myId)
        .is("deleted_at", null)
        .order("display_name", { ascending: true });
    if (error) return res.status(500).json({ success: false, message: error.message });

    res.json({
        success: true,
        sellers: (sellers || []).map((s) => ({ id: s.user_id, shopName: s.display_name, logoUrl: s.logo_url || null })),
    });
}