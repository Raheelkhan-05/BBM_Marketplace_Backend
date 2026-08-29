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

// Walks the user's conversations on connect and marks delivered anywhere
// they have an unconsumed incoming message — same idea as before, but
// the timestamp now comes from Postgres (mark_participant_delivered_bulk's
// `now()`) instead of Node's clock, so it's directly comparable against
// chat_messages.created_at (also Postgres-stamped) on the client.
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

    const { data, error } = await supabase
        .rpc("mark_participant_delivered_bulk", { p_conversation_ids: pendingConvIds, p_user_id: userId })
        .single();
    if (error) { console.error("[socket] syncPendingDeliveries bulk update failed:", error.message); return; }
    const deliveredAt = data.delivered_at;

    await Promise.all(
        pendingConvIds.map((conversationId) =>
            emitToConversation(conversationId, "message:status", { conversationId, deliveredAt, byUserIds: [userId] }, { excludeUserId: userId })
        )
    );
}

export function registerChatSocket(io) {
    io.on("connection", async (socket) => {
        const userId = socket.userId;

        socket.join(`user:${userId}`);

        const justCameOnline = markOnline(userId, socket.id);
        if (justCameOnline) {
            await supabase.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", userId);
            io.emit("presence:update", { userId, online: true });
            syncPendingDeliveries(userId).catch((err) => console.error("[socket] syncPendingDeliveries failed:", err.message));
        }

        socket.on("read:ack", async ({ conversationId }) => {
            try {
                const { data, error } = await supabase
                    .rpc("mark_participant_read", { p_conversation_id: conversationId, p_user_id: userId })
                    .single();
                if (error) throw error;
                await emitToConversation(conversationId, "message:status",
                    { conversationId, readAt: data.last_read_at, byUserIds: [userId] },
                    { excludeUserId: userId });
            } catch (err) {
                console.error("[socket] read:ack failed:", err.message);
            }
        });

        // FIX: was `new Date().toISOString()` (Node clock) written to
        // last_delivered_at, then compared client-side against
        // message.created_at (Postgres clock) — any clock skew between
        // the two hosts makes that comparison silently fail forever for
        // that message. Now sourced from Postgres via the same RPC
        // pattern as read:ack, so both sides of every future comparison
        // are stamped by the same clock.
        socket.on("delivered:ack", async ({ conversationId }) => {
            try {
                const { data, error } = await supabase
                    .rpc("mark_participant_delivered", { p_conversation_id: conversationId, p_user_id: userId })
                    .single();
                if (error) throw error;
                await emitToConversation(conversationId, "message:status",
                    { conversationId, deliveredAt: data.last_delivered_at, byUserIds: [userId] },
                    { excludeUserId: userId });
            } catch (err) {
                console.error("[socket] delivered:ack failed:", err.message);
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