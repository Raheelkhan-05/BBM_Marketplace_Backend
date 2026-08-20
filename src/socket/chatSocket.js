// socket/chatSocket.js
import { supabase } from "../config/supabase.js";
import { getParticipantIds } from "./participantsCache.js";

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
        }

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