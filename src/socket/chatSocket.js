import { supabase } from "../config/supabase.js";
import { getParticipantIds } from "./participantsCache.js";
import { emitToConversation } from "./emit.js";

const onlineUsers = new Map(); // userId -> Set<socketId>

function markOnline(userId, socketId) {
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socketId);
    return onlineUsers.get(userId).size === 1;
}
function markOffline(userId, socketId) {
    const set = onlineUsers.get(userId);
    if (!set) return false;
    set.delete(socketId);
    if (set.size === 0) { onlineUsers.delete(userId); return true; }
    return false;
}
export function isOnline(userId) { return onlineUsers.has(userId); }

// BUG FIX: this is new. Previously, "delivered" only ever got set at the
// moment a message was sent (sendMessage checks isOnline(recipient) and
// marks it delivered right then). If the recipient was offline at send
// time, their tick stayed stuck on "sent" until they opened that exact
// conversation thread (which calls markRead, which also bumps
// last_delivered_at as a side effect) — there was no "delivered" step in
// between, so reconnecting without opening the thread never updated
// anything. This walks the user's conversations on connect and marks
// delivered anywhere they have an unconsumed incoming message, the same
// way a real client (WhatsApp, etc.) acks delivery as soon as the device
// comes online, independent of which screen is open.
async function syncPendingDeliveries(userId) {
    const { data: myRows } = await supabase
        .from("chat_participants")
        .select("conversation_id, last_delivered_at")
        .eq("user_id", userId);
    if (!myRows?.length) return;

    const convIds = myRows.map((r) => r.conversation_id);
    const { data: convs } = await supabase
        .from("chat_conversations")
        .select("id, last_message_at, last_message_sender_id")
        .in("id", convIds);
    if (!convs?.length) return;

    const lastDeliveredById = Object.fromEntries(myRows.map((r) => [r.conversation_id, r.last_delivered_at]));
    const pendingConvIds = convs
        .filter((c) => c.last_message_sender_id && c.last_message_sender_id !== userId && c.last_message_at)
        .filter((c) => !lastDeliveredById[c.id] || new Date(lastDeliveredById[c.id]).getTime() < new Date(c.last_message_at).getTime())
        .map((c) => c.id);
    if (!pendingConvIds.length) return;

    const now = new Date().toISOString();
    await supabase
        .from("chat_participants")
        .update({ last_delivered_at: now })
        .eq("user_id", userId)
        .in("conversation_id", pendingConvIds);

    await Promise.all(
        pendingConvIds.map((conversationId) =>
            emitToConversation(conversationId, "message:status", { conversationId, deliveredAt: now, byUserIds: [userId] }, { excludeUserId: userId })
        )
    );
}

export function registerChatSocket(io) {
    io.on("connection", async (socket) => {
        const userId = socket.userId;

        // ONE room, for life. Conversation-scoped delivery is handled by
        // emitToConversation() looking up participants server-side — the
        // client never needs to join/leave anything conversation-specific.
        socket.join(`user:${userId}`);

        const justCameOnline = markOnline(userId, socket.id);
        if (justCameOnline) {
            await supabase.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", userId);
            io.emit("presence:update", { userId, online: true });
            syncPendingDeliveries(userId).catch((err) => console.error("[socket] syncPendingDeliveries failed:", err.message));
        }

        // FIX: read receipts for a conversation the recipient already has
        // open used to go out purely over REST (markConversationRead) —
        // client HTTP request -> Express -> Supabase write -> response,
        // and only *then* would the emit back to the sender fire. That's
        // an extra full request/response hop stacked in front of the two
        // socket pushes that already have to happen (message reaching the
        // recipient, status reaching the sender back). For someone
        // sitting in an already-open thread this hop is pure added
        // latency for no benefit — the socket connection is right there.
        // This does the same last_read_at/last_delivered_at update and
        // status emit, but over the existing socket round trip instead.
        // The REST endpoint (routes/chat.routes.js -> markRead) stays in
        // place as the fallback for cases with no live socket (e.g. a
        // backgrounded mobile client reconciling on resume).
        socket.on("read:ack", async ({ conversationId }) => {
            try {
                const now = new Date().toISOString();
                const { error } = await supabase
                    .from("chat_participants")
                    .update({ last_read_at: now, last_delivered_at: now })
                    .eq("conversation_id", conversationId)
                    .eq("user_id", userId);
                if (error) throw error;
                await emitToConversation(conversationId, "message:status", { conversationId, readAt: now, byUserIds: [userId] }, { excludeUserId: userId });
            } catch (err) {
                console.error("[socket] read:ack failed:", err.message);
            }
        });

        socket.on("typing:start", async ({ conversationId }) => {
            const ids = await getParticipantIds(conversationId);
            ids.filter((id) => id !== userId).forEach((id) => io.to(`user:${id}`).emit("typing:update", { conversationId, userId, typing: true }));
        });
        socket.on("typing:stop", async ({ conversationId }) => {
            const ids = await getParticipantIds(conversationId);
            ids.filter((id) => id !== userId).forEach((id) => io.to(`user:${id}`).emit("typing:update", { conversationId, userId, typing: false }));
        });

        socket.on("presence:query", (targetUserId, cb) => {
            cb?.({ online: isOnline(targetUserId) });
        });
        // batch variant — ConversationList needs many at once, don't round-trip per row
        socket.on("presence:query_many", (userIds, cb) => {
            cb?.(Object.fromEntries((userIds || []).map((id) => [id, isOnline(id)])));
        });

        socket.on("disconnect", () => {
            const fullyOffline = markOffline(userId, socket.id);
            if (fullyOffline) {
                setTimeout(async () => {
                    if (!isOnline(userId)) {
                        const lastSeen = new Date().toISOString();
                        await supabase.from("profiles").update({ last_seen_at: lastSeen }).eq("id", userId);
                        io.emit("presence:update", { userId, online: false, lastSeenAt: lastSeen });
                    }
                }, 4000);
            }
        });
    });
}