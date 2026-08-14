import { supabaseAdmin } from "../config/supabase.js";
import { channelTokenFor } from "./channelToken.js";
import { broadcast } from "./realtimeBroadcaster.js";

export async function notifyUser(userId, { type, title, body = null, message = null, link = null }) {
    const resolvedBody = body ?? message;
    const { data, error } = await supabaseAdmin
        .from("notifications")
        .insert({ user_id: userId, type, title, body: resolvedBody, link, read: false })
        .select()
        .single();
    if (error) { console.error("notifyUser insert failed:", error.message); return; }
    await broadcast(`user-${channelTokenFor(userId)}`, "new_notification", data);
}

export async function notifyAdmins({ type, title, body = null, message = null, link = null }) {
    const resolvedBody = body ?? message;
    const { data: admins, error } = await supabaseAdmin.from("profiles").select("id").eq("role", "admin");
    if (error) return console.error("notifyAdmins fetch failed:", error.message);
    if (!admins?.length) return;
    const rows = admins.map((a) => ({ user_id: a.id, type, title, body: resolvedBody, link, read: false }));
    const { data: inserted, error: insertErr } = await supabaseAdmin.from("notifications").insert(rows).select();
    if (insertErr) return console.error("notifyAdmins insert failed:", insertErr.message);
    await Promise.all(inserted.map((row) => broadcast(`user-${channelTokenFor(row.user_id)}`, "new_notification", row)));
}

export async function notifySellerSubmissionsChanged(userId) {
    if (!userId) return;
    await broadcast(`user-${channelTokenFor(userId)}`, "submissions_changed", {});
}

export async function notifyAdminSubmissionsChanged() {
    await broadcast("admin-submissions", "submissions_changed", {});
}