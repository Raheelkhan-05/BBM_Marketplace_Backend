import { supabaseAdmin } from "../config/supabase.js";
import { channelTokenFor } from "./channelToken.js";

// Server-authoritative pushes. The backend already knows exactly who's
// allowed to see what at the moment of mutation — so we push explicitly
// instead of depending on postgres_changes + RLS.
export async function notifyUser(userId, { type, title, body, link }) {
    const { data: notification, error } = await supabaseAdmin
        .from("notifications")
        .insert({ user_id: userId, type, title, body, link })
        .select()
        .single();
    if (error) { console.error("[notifyUser] insert failed:", error.message); return null; }

    await supabaseAdmin.channel(`user-${channelTokenFor(userId)}`)
        .send({ type: "broadcast", event: "new_notification", payload: notification });
    return notification;
}

export async function notifyOrderChanged(orderId, patch) {
    await supabaseAdmin.channel(`order-${orderId}`)
        .send({ type: "broadcast", event: "order_updated", payload: patch });
}

// Tells a user's order list to re-fetch (new order, or any status change on
// one of their orders) — separate event from new_notification so the bell
// and the list can react independently.
export async function notifyUserOrdersChanged(userId) {
    await supabaseAdmin.channel(`user-${channelTokenFor(userId)}`)
        .send({ type: "broadcast", event: "orders_changed", payload: {} });
}