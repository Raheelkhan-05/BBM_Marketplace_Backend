// services/creditEvents.js
//
// One place that (1) writes the credit history row and (2) tells both
// people's open screens to refresh. Never throws — a logging or socket
// hiccup must not turn a successful credit action into an error.
import { supabase } from "../config/supabase.js";
import { getIO } from "../socket/io.js";

export async function trackCreditEvent({
    creditId, buyerId, sellerId, sellerUserId,
    actorId, actorRole, eventType, creditLimit = null,
}) {
    try {
        let sellerUid = sellerUserId;
        if (!sellerUid && sellerId) {
            const { data } = await supabase.from("seller_profiles").select("user_id").eq("id", sellerId).maybeSingle();
            sellerUid = data?.user_id;
        }
        if (!creditId || !buyerId || !sellerId || !sellerUid) {
            console.error("[credit] event skipped, missing ids:", { creditId, buyerId, sellerId, sellerUid, eventType });
            return;
        }

        const { error } = await supabase.from("credit_events").insert({
            credit_id: creditId,
            buyer_id: buyerId,
            seller_id: sellerId,
            seller_user_id: sellerUid,
            actor_id: actorId,
            actor_role: actorRole,
            event_type: eventType,
            credit_limit: creditLimit != null && Number.isFinite(Number(creditLimit)) ? Number(creditLimit) : null,
        });
        if (error) console.error("[credit] event insert failed:", error.message);

        // Both people (including the one who acted, so their other tabs/devices
        // stay in sync) get a "something changed" ping; clients refetch.
        const io = getIO();
        const payload = { creditId, eventType, at: new Date().toISOString() };
        for (const uid of new Set([buyerId, sellerUid])) {
            io.to(`user:${uid}`).emit("credit:changed", payload);
        }
    } catch (e) {
        console.error("[credit] trackCreditEvent failed:", e.message);
    }
}