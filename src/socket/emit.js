// socket/emit.js
import { getIO } from "./io.js";
import { getParticipantIds } from "./participantsCache.js";

// Fans an event out to every participant's PERSONAL room. No conversation
// room membership required — this is what makes delivery/read receipts
// work regardless of which window a user currently has open.
export async function emitToConversation(conversationId, event, payload, { excludeUserId } = {}) {
    const io = getIO();
    const ids = await getParticipantIds(conversationId);
    ids.forEach((id) => {
        if (id === excludeUserId) return;
        io.to(`user:${id}`).emit(event, payload);
    });
}