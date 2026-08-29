import { supabase } from "../config/supabase.js";
import { getIO } from "../socket/io.js";

export async function notifyUser(userId, { type, title, body = null, link = null }) {
    const { data, error } = await supabase
        .from("notifications")
        .insert({ user_id: userId, type, title, body, link })
        .select()
        .single();
    if (error) { console.error("[notifyUser] insert failed:", error.message); return null; }
    try { getIO().to(`user:${userId}`).emit("notification:new", data); }
    catch (err) { console.error("[notifyUser] emit failed:", err.message); }
    return data;
}

export async function notifyOrderChanged(orderId, patch) {
    try { getIO().to(`order:${orderId}`).emit("order_updated", patch); }
    catch (err) { console.error("[notifyOrderChanged] emit failed:", err.message); }
}

export async function notifyUserOrdersChanged(userId) {
    try { getIO().to(`user:${userId}`).emit("orders_changed", {}); }
    catch (err) { console.error("[notifyUserOrdersChanged] emit failed:", err.message); }
}