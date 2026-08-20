// socket/participantsCache.js
//
// Typing/message/status events need "who's in this conversation" on
// every emit. Hitting Postgres for that on every keystroke-driven
// typing event would be wasteful — cache it, short TTL, invalidated
// whenever membership actually changes (new conversation, new member).
import { supabase } from "../config/supabase.js";

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // conversationId -> { ids: string[], expiresAt: number }

export async function getParticipantIds(conversationId) {
    const hit = cache.get(conversationId);
    if (hit && hit.expiresAt > Date.now()) return hit.ids;

    const { data, error } = await supabase
        .from("chat_participants")
        .select("user_id")
        .eq("conversation_id", conversationId);
    if (error) throw error;

    const ids = (data || []).map((r) => r.user_id);
    cache.set(conversationId, { ids, expiresAt: Date.now() + CACHE_TTL_MS });
    return ids;
}

export function invalidateParticipants(conversationId) {
    cache.delete(conversationId);
}