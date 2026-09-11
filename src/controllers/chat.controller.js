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

    // actual unread MESSAGE counts, not just a boolean. We already have
    // each conversation's last_read_at watermark from myRows above —
    // fetch every message in these conversations NOT sent by this user,
    // then bucket-count per conversation against that watermark.
    const { data: candidateMessages } = await supabase
        .from("chat_messages")
        .select("conversation_id, created_at")
        .in("conversation_id", convIds)
        .neq("sender_id", userId)
        .is("deleted_at", null);

    const lastReadById = Object.fromEntries(myRows.map((r) => [r.conversation_id, r.last_read_at]));
    const unreadCountById = {};
    for (const m of candidateMessages || []) {
        const threshold = lastReadById[m.conversation_id];
        if (!threshold || new Date(m.created_at) > new Date(threshold)) {
            unreadCountById[m.conversation_id] = (unreadCountById[m.conversation_id] || 0) + 1;
        }
    }

    const otherUserIds = [...new Set(
        convs.flatMap((c) => (c.is_group ? [] : [c.direct_user_a, c.direct_user_b]).filter((id) => id !== userId))
    )];
    // IMPORTANT: no `.is("deleted_at", null)` filter here — unlike the
    // browse/search paths, a chat with a since-deleted seller still needs
    // to render (shop name intact) so the buyer's message history isn't
    // wiped or replaced with "Unknown seller". We fetch deleted_at instead
    // so the UI can show the name AND flag it as deleted.
    const { data: otherSellerProfiles } = otherUserIds.length
        ? await supabase.from("seller_profiles").select("user_id, display_name, logo_url, deleted_at").in("user_id", otherUserIds)
        : { data: [] };
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
            otherIsDeletedSeller: c.is_group ? false : !!otherShop?.deleted_at, // NEW
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

    if (!(await assertParticipant(conversationId, userId))) {
        return res.status(403).json({ success: false, message: "Not a participant." });
    }

    let query = supabase
        .from("chat_messages")
        .select("id, conversation_id, sender_id, body, attachment_url, created_at, edited_at, deleted_at, client_message_id, message_type, metadata")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(MESSAGE_PAGE_SIZE);
    if (before) query = query.lt("created_at", before);

    const { data: rows, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    const hasMore = rows.length === MESSAGE_PAGE_SIZE;
    const oldestInPage = rows.length ? rows[rows.length - 1].created_at : null;

    const { data: participants } = await supabase
        .from("chat_participants")
        .select("user_id, last_delivered_at, last_read_at")
        .eq("conversation_id", conversationId);
    const others = (participants || []).filter((p) => p.user_id !== userId);

    const { data: myDeletions } = await supabase
        .from("chat_message_deletions")
        .select("message_id")
        .eq("user_id", userId);
    const deletedForMeIds = new Set((myDeletions || []).map((d) => d.message_id));

    const messages = rows
        .filter((m) => !deletedForMeIds.has(m.id))
        .slice()
        .reverse()
        .map((m) => ({ ...m, status: m.sender_id === userId ? deriveStatus(m, others) : undefined }));

    const otherWatermarks = others.length === 1
        ? { deliveredAt: others[0].last_delivered_at, readAt: others[0].last_read_at }
        : null;

    // NEW: tell the client whether sending is currently allowed in this
    // conversation, so the composer can disable itself proactively
    // instead of only finding out on a failed send. Only meaningful for
    // 1:1 chats — groups aren't gated by a single "other party" status.
    let canSend = true;
    if (others.length === 1) {
        const { isDeleted } = await getSellerDeletionStatus(others[0].user_id);
        canSend = !isDeleted;
    }

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
    if (!(await assertParticipant(conversationId, userId))) return res.status(403).json({ success: false, message: "Not a participant." });

    // NEW: block sending into a conversation where the other party (for
    // 1:1 chats) is a deleted seller. Checked on BOTH sides — a buyer
    // can't message a deleted seller, and if a deleted seller's session
    // somehow still tries to send, that's blocked too, since their own
    // account is what's deleted.
    const otherUserId = await getOtherParticipantId(conversationId, userId);
    if (otherUserId) {
        const [otherStatus, selfStatus] = await Promise.all([
            getSellerDeletionStatus(otherUserId),
            getSellerDeletionStatus(userId),
        ]);
        if (otherStatus.isDeleted || selfStatus.isDeleted) {
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

    const preview = body?.trim() ? (body.trim().length > 80 ? body.trim().slice(0, 80) + "…" : body.trim()) : "📎 Attachment";

    await Promise.all([
        supabase.from("chat_conversations").update({ last_message_id: message.id, last_message_preview: preview, last_message_sender_id: userId, last_message_at: message.created_at }).eq("id", conversationId),
        supabase.from("chat_participants").update({ last_read_at: message.created_at, last_delivered_at: message.created_at }).eq("conversation_id", conversationId).eq("user_id", userId),
    ]);

    const payload = { ...message, status: "sent" };
    await emitToConversation(conversationId, "message:new", payload);

    const { data: recipients } = await supabase.from("chat_participants").select("user_id, is_muted").eq("conversation_id", conversationId).neq("user_id", userId);
    const deliveredTo = (recipients || []).filter((r) => isOnline(r.user_id)).map((r) => r.user_id);
    if (deliveredTo.length) {
        const { data: dRow, error: dErr } = await supabase
            .rpc("mark_participants_delivered_for_conversation", { p_conversation_id: conversationId, p_user_ids: deliveredTo })
            .single();
        if (dErr) {
            console.error("[chat] delivered-on-send update failed:", dErr.message);
        } else {
            await emitToConversation(conversationId, "message:status", { conversationId, deliveredAt: dRow.delivered_at, byUserIds: deliveredTo });
        }
    }

    await emitToConversation(conversationId, "conversation:updated", { conversationId }, { excludeUserId: userId });

    const toNotify = (recipients || []).filter((r) => !r.is_muted);
    const [{ data: senderShop }, { data: senderProfile }] = await Promise.all([
        supabase.from("seller_profiles").select("display_name").eq("user_id", userId).is("deleted_at", null).maybeSingle(),
        supabase.from("profiles").select("name").eq("id", userId).single(),
    ]);
    const notificationTitle = senderShop?.display_name || senderProfile?.name || "New message";

    if (toNotify.length) {
        const { data: inserted } = await supabase.from("notifications").insert(
            toNotify.map((r) => ({ user_id: r.user_id, type: "message", title: notificationTitle, body: preview, link: `/chat/${conversationId}`, read: false }))
        ).select("id, user_id, title, body, link, created_at");
        const io = getIO();
        (inserted || []).forEach((n) => io.to(`user:${n.user_id}`).emit("notification:new", n));
    }
    res.json({ success: true, message: payload });
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