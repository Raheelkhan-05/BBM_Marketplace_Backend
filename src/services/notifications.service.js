// Thin wrapper around whatever table backs GET /api/notifications.
// Assumes: id, user_id, type, title, message, link, is_read, created_at.
// Adjust column names if your real schema differs.

import { supabase } from "../config/supabase.js";

export async function notifyUser(userId, { type, title, message, link = null }) {
    const { error } = await supabase.from("notifications").insert({
        user_id: userId,
        type,
        title,
        message,
        link,
        is_read: false,
    });
    if (error) console.error("notifyUser failed:", error.message);
}