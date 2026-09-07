import { supabase } from "../config/supabase.js";
import { emitToConversation } from "../socket/emit.js";
import { notifyUser } from "../services/realtimeBroadcast.js";

// GET /api/transport/preference?otherUserId=...
// Role-agnostic, same dual-direction resolution as getCreditStatus —
// necessary because unlike credit (always buyer requests from seller),
// EITHER side of this pair can be viewing it as "otherUserId".
// GET /api/transport/preference?otherUserId=...  OR  ?submissionId=...
export async function getTransportPreference(req, res) {
    const { otherUserId, submissionId, conversationId } = req.query;

    // NEW: buyer-side lookup from a listing, same pattern as getCreditStatus
    if (submissionId) {
        const { data: sub } = await supabase.from("seller_product_submissions").select("seller_id").eq("id", submissionId).maybeSingle();
        if (!sub) return res.status(404).json({ success: false, message: "Listing not found." });
        const { data: sp } = await supabase.from("seller_profiles").select("user_id").eq("id", sub.seller_id).maybeSingle();
        // A buyer/seller pair can now have a transport row per conversation
        // rather than a single shared one, so order by most recent and take
        // one instead of risking .maybeSingle() throwing on >1 row. This is
        // a pre-conversation, listing-based lookup, so there's no
        // conversationId to disambiguate by yet.
        const { data: rows } = await supabase.from("buyer_seller_transport_prefs").select("*")
            .eq("buyer_id", req.user.id).eq("seller_id", sub.seller_id)
            .order("requested_at", { ascending: false }).limit(1);
        const row = rows?.[0] || null;

        return res.json({ success: true, preference: row || null, viewerRole: "buyer", sellerUserId: sp?.user_id || null });
    }

    if (!otherUserId) return res.status(400).json({ success: false, message: "otherUserId or submissionId required." });

    const [{ data: meAsSeller }, { data: otherAsSeller }] = await Promise.all([
        supabase.from("seller_profiles").select("id").eq("user_id", req.user.id).maybeSingle(),
        supabase.from("seller_profiles").select("id").eq("user_id", otherUserId).maybeSingle(),
    ]);

    // conversation_id is now the unique key on buyer_seller_transport_prefs,
    // so the same buyer/seller pair can have several rows (one per
    // conversation). Scope to conversationId when the caller has it
    // (ChatWindow always does) so .maybeSingle() can't hit >1 row; without
    // it, fall back to most-recent for callers that haven't been updated.
    const [sellerDirection, buyerDirection] = await Promise.all([
        meAsSeller
            ? (async () => {
                let q = supabase.from("buyer_seller_transport_prefs").select("*").eq("buyer_id", otherUserId).eq("seller_id", meAsSeller.id);
                if (conversationId) return q.eq("conversation_id", conversationId).maybeSingle();
                const { data } = await q.order("requested_at", { ascending: false }).limit(1);
                return { data: data?.[0] || null };
            })()
            : Promise.resolve({ data: null }),
        otherAsSeller
            ? (async () => {
                let q = supabase.from("buyer_seller_transport_prefs").select("*").eq("buyer_id", req.user.id).eq("seller_id", otherAsSeller.id);
                if (conversationId) return q.eq("conversation_id", conversationId).maybeSingle();
                const { data } = await q.order("requested_at", { ascending: false }).limit(1);
                return { data: data?.[0] || null };
            })()
            : Promise.resolve({ data: null }),
    ]);

    const row = sellerDirection.data || buyerDirection.data || null;
    const viewerRole = sellerDirection.data ? "seller" : buyerDirection.data ? "buyer" : (otherAsSeller ? "buyer" : meAsSeller ? "seller" : null);
    res.json({ success: true, preference: row, viewerRole, sellerUserId: otherAsSeller ? otherUserId : req.user.id });
}

export async function proposeTransport(req, res) {
    const { otherUserId, conversationId, mode, transportCompany, details } = req.body;
    if (!otherUserId || !conversationId || !mode) {
        return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const [{ data: meAsSeller }, { data: otherAsSeller }] = await Promise.all([
        supabase.from("seller_profiles").select("id, user_id").eq("user_id", req.user.id).maybeSingle(),
        supabase.from("seller_profiles").select("id, user_id").eq("user_id", otherUserId).maybeSingle(),
    ]);

    let buyerId, sellerId, sellerUserId, buyerUserId;
    if (otherAsSeller) { buyerId = req.user.id; buyerUserId = req.user.id; sellerId = otherAsSeller.id; sellerUserId = otherUserId; }
    else if (meAsSeller) { buyerId = otherUserId; buyerUserId = otherUserId; sellerId = meAsSeller.id; sellerUserId = req.user.id; }
    else return res.status(400).json({ success: false, message: "Neither party in this chat is a seller." });

    const { data } = await supabase.rpc("propose_transport", {
        p_buyer_id: buyerId, p_seller_id: sellerId, p_proposer_id: req.user.id,
        p_conversation_id: conversationId, p_mode: mode, p_transport_company: transportCompany || null, p_details: details || null,
    });
    // if (error) {
    //     console.error("[proposeTransport] RPC error:", error);
    //     return res.status(400).json({ success: false, message: "Couldn't send the proposal.", code: error.message });
    // }

    const row = Array.isArray(data) ? data[0] : data;
    const [{ data: message }, { data: preference }] = await Promise.all([
        supabase.from("chat_messages").select("*").eq("id", row.message_id).single(),
        supabase.from("buyer_seller_transport_prefs").select("*").eq("id", row.pref_id).single(),
    ]);

    // Respond with the FULL preference row, not just the id — the client
    // applies this directly instead of re-deriving it via a second fetch.
    res.json({ success: true, prefId: row.pref_id, preference });

    emitToConversation(conversationId, "message:new", { ...message, status: "sent" })
        .catch((err) => console.error("[proposeTransport] emit message:new failed:", err));
    emitToConversation(conversationId, "transport:proposed", { conversationId, preference }, { excludeUserId: req.user.id })
        .catch((err) => console.error("[proposeTransport] emit transport:proposed failed:", err));
    if (row.superseded_message_id) {
        emitToConversation(conversationId, "message:updated", {
            conversationId, messageId: row.superseded_message_id,
            metadataPatch: { finalStatus: row.superseded_final_status },
        }).catch((err) => console.error("[proposeTransport] emit message:updated failed:", err));
    }

    const otherId = req.user.id === buyerUserId ? sellerUserId : buyerUserId;
    notifyUser(otherId, {
        type: "transport_proposal",
        title: "Transport preference proposed",
        body: `Mode: ${mode}${transportCompany ? ` · ${transportCompany}` : ""}`,
        link: `/chat/${conversationId}`,
    }).catch((err) => console.error("[proposeTransport] notifyUser failed:", err));
}

export async function decideTransport(req, res) {
    const { decision } = req.body;
    if (!["confirmed", "declined"].includes(decision)) {
        return res.status(400).json({ success: false, message: "Invalid decision." });
    }

    const { data } = await supabase.rpc("decide_transport", { p_pref_id: req.params.id, p_deciding_user_id: req.user.id, p_decision: decision });
    const row = Array.isArray(data) ? data[0] : data;

    const { data: pref, error: fetchErr } = await supabase.from("buyer_seller_transport_prefs").select("*").eq("id", req.params.id).single();
    if (fetchErr || !pref) {
        console.error("[decideTransport] Failed to reload preference after decision:", fetchErr);
        return res.status(500).json({ success: false, message: "Decision saved, but couldn't confirm it — refresh to see the latest status." });
    }

    res.json({ success: true, status: pref.status, preference: pref });

    if (pref.conversation_id) {
        emitToConversation(pref.conversation_id, "transport:decided", { conversationId: pref.conversation_id, preference: pref })
            .catch((err) => console.error("[decideTransport] emitToConversation failed:", err));
    }
    if (row?.request_message_id) {
        emitToConversation(pref.conversation_id, "message:updated", {
            conversationId: pref.conversation_id, messageId: row.request_message_id,
            metadataPatch: { finalStatus: decision },
        }).catch((err) => console.error("[decideTransport] emit message:updated failed:", err));
    }
    notifyUser(pref.proposed_by, {
        type: "transport_decision",
        title: decision === "confirmed" ? "Transport preference agreed" : "Transport proposal declined",
        body: decision === "confirmed" ? "Your proposed transport preference was accepted." : "Your transport proposal was declined — try proposing a different one.",
        link: pref.conversation_id ? `/chat/${pref.conversation_id}` : undefined,
    }).catch((err) => console.error("[decideTransport] notifyUser failed:", err));
}