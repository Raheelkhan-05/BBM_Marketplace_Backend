import { supabase } from "../config/supabase.js";
import { channelTokenFor } from "./channelToken.js";

export async function notifyUser(userId, { type, title, body = null, message = null, link = null }) {
    const resolvedBody = body ?? message;

    const { data, error } = await supabase
        .from("notifications")
        .insert({ user_id: userId, type, title, body: resolvedBody, link, read: false })
        .select()
        .single();

    if (error) {
        console.error("notifyUser insert failed:", error.message);
        return;
    }

    await broadcastToUser(userId, data);
}

export async function notifyAdmins({ type, title, body = null, message = null, link = null }) {
    const resolvedBody = body ?? message;

    const { data: admins, error } = await supabase.from("profiles").select("id").eq("role", "admin");
    if (error) return console.error("notifyAdmins fetch failed:", error.message);
    if (!admins?.length) return;

    const rows = admins.map((a) => ({ user_id: a.id, type, title, body: resolvedBody, link, read: false }));

    const { data: inserted, error: insertErr } = await supabase.from("notifications").insert(rows).select();
    if (insertErr) return console.error("notifyAdmins insert failed:", insertErr.message);

    await Promise.all(inserted.map((row) => broadcastToUser(row.user_id, row)));
}

async function broadcastToUser(userId, notification) {
    const channelName = `notifications-${channelTokenFor(userId)}`;
    const channel = supabase.channel(channelName);
    await channel.send({ type: "broadcast", event: "new_notification", payload: notification });
    await supabase.removeChannel(channel);
}