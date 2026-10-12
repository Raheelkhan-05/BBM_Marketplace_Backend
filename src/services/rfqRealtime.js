import { getIO } from "../socket/io.js";

// Event the client listens to: "rfq_quotes_changed". Users join the room `user:<id>` in socket/chatSocket.js.
export function emitRfqQuotesChanged(userIds, payload = {}) {
    const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
    if (!ids.length) return;
    try {
        const io = getIO();
        ids.forEach((id) => io.to(`user:${id}`).emit("rfq_quotes_changed", payload));
    } catch (e) {
        console.error("[rfq] realtime emit failed:", e.message);
    }
}