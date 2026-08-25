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

    const otherUserIds = [...new Set(
        convs.flatMap((c) => (c.is_group ? [] : [c.direct_user_a, c.direct_user_b]).filter((id) => id !== userId))
    )];
    // Shop name only — never fetch/expose the personal profile name here.
    const { data: otherSellerProfiles } = otherUserIds.length
        ? await supabase.from("seller_profiles").select("user_id, display_name, logo_url").in("user_id", otherUserIds)
        : { data: [] };
    const shopById = Object.fromEntries((otherSellerProfiles || []).map((p) => [p.user_id, p]));

    const myRowById = Object.fromEntries(myRows.map((r) => [r.conversation_id, r]));

    const conversations = convs.map((c) => {
        const mine = myRowById[c.id];
        const unread = c.last_message_at && (!mine.last_read_at || new Date(mine.last_read_at) < new Date(c.last_message_at));
        const otherId = c.is_group ? null : (c.direct_user_a === userId ? c.direct_user_b : c.direct_user_a);
        return {
            id: c.id,
            isGroup: c.is_group,
            title: c.is_group ? c.title : undefined,
            otherShopName: c.is_group ? undefined : (shopById[otherId]?.display_name || "Unknown seller"),
            otherShopLogo: c.is_group ? undefined : (shopById[otherId]?.logo_url || null),
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
        .select("id, conversation_id, sender_id, body, attachment_url, created_at, edited_at, deleted_at, client_message_id, message_type, metadata")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(MESSAGE_PAGE_SIZE);
    if (before) query = query.lt("created_at", before);

    const { data: rows, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    const hasMore = rows.length === MESSAGE_PAGE_SIZE;

    // BUG FIX: the pagination cursor must come from the raw fetched page
    // (its oldest row), independent of any per-user "delete for me"
    // filtering below. The old code derived the cursor from the *filtered*
    // array (`messages[0]`), so once a user had deleted even one message
    // in a page, the next "load older" call would silently skip messages
    // around the deleted one.
    const oldestInPage = rows.length ? rows[rows.length - 1].created_at : null;

    const { data: participants } = await supabase
        .from("chat_participants")
        .select("user_id, last_delivered_at, last_read_at")
        .eq("conversation_id", conversationId);
    const others = (participants || []).filter((p) => p.user_id !== userId);

    // BUG FIX: previously this block computed a filtered `visible` array
    // (dropping messages the user deleted "for me") but then never used
    // it — the response always sent the raw, unfiltered `messages`. That
    // is why "delete for me" appeared to do nothing after a refresh or
    // when paginating: the deletion was recorded, but never applied to
    // what got sent back.
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

    // BUG FIX: the client used to seed its live read/delivered watermark
    // at {deliveredAt: null, readAt: null} on every mount, and only ever
    // learned the real values from a *live* socket event after that. That
    // meant every one of your sent messages rendered as a single "sent"
    // tick on initial load, even ones the other person had already read
    // days ago — the tick only jumped to the correct state if a new
    // status event happened to fire while you were looking at the
    // screen. Sending the current watermark down lets the client seed
    // correctly on first paint. (Only meaningful for direct/1:1 chats —
    // for groups, each message's `status` above is already the
    // authoritative per-message value.)
    const otherWatermarks = others.length === 1
        ? { deliveredAt: others[0].last_delivered_at, readAt: others[0].last_read_at }
        : null;

    res.json({ success: true, messages, hasMore, oldestCursor: oldestInPage, otherWatermarks });
}

// ---- creating/finding a 1:1 conversation ----
export async function getOrCreateDirectConversation(req, res) {
    const userId = req.user.id;
    const { otherUserId } = req.body;
    if (!otherUserId || otherUserId === userId) {
        return res.status(400).json({ success: false, message: "Invalid recipient." });
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
    // excludeUserId: the sender already has this message from the
    // optimistic bubble + HTTP response; re-delivering it over the socket
    // to the *same* tab just adds dedup work for no benefit (other open
    // tabs/devices for this user still get it, since emitToConversation
    // fans out to every participant's personal room, not this socket).
    await emitToConversation(conversationId, "message:new", payload);

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

    // reaches the sender no matter what window/device they currently have
    // open, since emitToConversation targets each participant's personal
    // room rather than a conversation-scoped room.
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
        .order("display_name", { ascending: true });
    if (error) return res.status(500).json({ success: false, message: error.message });

    res.json({
        success: true,
        sellers: (sellers || []).map((s) => ({ id: s.user_id, shopName: s.display_name, logoUrl: s.logo_url || null })),
    });
}