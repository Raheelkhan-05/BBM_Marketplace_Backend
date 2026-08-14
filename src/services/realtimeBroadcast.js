import { supabaseAdmin } from "../config/supabase.js";
import { channelTokenFor } from "./channelToken.js";
import { broadcast } from "./realtimeBroadcaster.js";

export async function notifyUser(userId, { type, title, body, link }) {
    const { data: notification, error } = await supabaseAdmin
        .from("notifications")
        .insert({ user_id: userId, type, title, body, link })
        .select()
        .single();
    if (error) { console.error("[notifyUser] insert failed:", error.message); return null; }
    await broadcast(`user-${channelTokenFor(userId)}`, "new_notification", notification);
    return notification;
}

export async function notifyOrderChanged(orderId, patch) {
    await broadcast(`order-${orderId}`, "order_updated", patch);
}

export async function notifyUserOrdersChanged(userId) {
    await broadcast(`user-${channelTokenFor(userId)}`, "orders_changed", {});
}