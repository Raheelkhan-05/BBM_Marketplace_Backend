import { supabase } from "../config/supabase.js";
import { getIO } from "../socket/io.js";

export async function notifyUser(userId, { type, title, body = null, link = null, ...extra }) {
    const { data, error } = await supabase
        .from("notifications")
        .insert({ user_id: userId, type, title, body, link })
        .select()
        .single();
    if (error) { console.error("[notifyUser] insert failed:", error.message); return null; }

    // `extra` carries fields that exist only to help a live client match this
    // event against local state in real time (e.g. routeOptionId, reason for
    // transport proposal events) — deliberately NOT persisted to the
    // notifications table, since that table is the durable bell/history record
    // and these fields have their own durable home elsewhere (e.g.
    // transport_route_options.rejection_reason). We merge them into the
    // socket payload only, so a listener gets both the saved notification
    // row AND these extra routing hints in one event.
    const socketPayload = { ...data, ...extra };

    try { getIO().to(`user:${userId}`).emit("notification:new", socketPayload); }
    catch (err) { console.error("[notifyUser] emit failed:", err.message); }
    return data;
}

// Same room notifyUser uses, but a plain event: nothing is stored, no bell entry.
export function emitToUser(userId, event, payload = {}) {
    try { getIO().to(`user:${userId}`).emit(event, payload); }
    catch (err) { console.error("[emitToUser] emit failed:", err.message); }
}

export async function notifyOrderChanged(orderId, patch) {
    try { getIO().to(`order:${orderId}`).emit("order_updated", patch); }
    catch (err) { console.error("[notifyOrderChanged] emit failed:", err.message); }
}

export async function notifyUserOrdersChanged(userId) {
    try { getIO().to(`user:${userId}`).emit("orders_changed", {}); }
    catch (err) { console.error("[notifyUserOrdersChanged] emit failed:", err.message); }
}

// Tells both people's open screens that credit USAGE moved (credit order placed / cancelled / rejected / not accepted).
export function notifyCreditChanged(userIds, payload = {}) {
    try {
        const io = getIO();
        for (const uid of new Set((userIds || []).filter(Boolean))) {
            io.to(`user:${uid}`).emit("credit:changed", { eventType: "usage_changed", at: new Date().toISOString(), ...payload });
        }
    } catch (err) { console.error("[notifyCreditChanged] emit failed:", err.message); }
}