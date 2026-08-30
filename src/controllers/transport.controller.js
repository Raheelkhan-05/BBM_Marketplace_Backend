import { supabase } from "../config/supabase.js";
import { emitToConversation } from "../socket/emit.js";
import { notifyUser } from "../services/realtimeBroadcast.js";

// GET /api/transport/preference?otherUserId=...
// Role-agnostic, same dual-direction resolution as getCreditStatus —
// necessary because unlike credit (always buyer requests from seller),
// EITHER side of this pair can be viewing it as "otherUserId".
// GET /api/transport/preference?otherUserId=...  OR  ?submissionId=...
export async function getTransportPreference(req, res) {
    const { otherUserId, submissionId } = req.query;

    // NEW: buyer-side lookup from a listing, same pattern as getCreditStatus
    if (submissionId) {
        const { data: sub } = await supabase.from("seller_product_submissions").select("seller_id").eq("id", submissionId).maybeSingle();
        if (!sub) return res.status(404).json({ success: false, message: "Listing not found." });
        const { data: sp } = await supabase.from("seller_profiles").select("user_id").eq("id", sub.seller_id).maybeSingle();
        const { data: row } = await supabase.from("buyer_seller_transport_prefs").select("*")
            .eq("buyer_id", req.user.id).eq("seller_id", sub.seller_id).maybeSingle();
        return res.json({ success: true, preference: row || null, viewerRole: "buyer", sellerUserId: sp?.user_id || null });
    }

    if (!otherUserId) return res.status(400).json({ success: false, message: "otherUserId or submissionId required." });

    const [{ data: meAsSeller }, { data: otherAsSeller }] = await Promise.all([
        supabase.from("seller_profiles").select("id").eq("user_id", req.user.id).maybeSingle(),
        supabase.from("seller_profiles").select("id").eq("user_id", otherUserId).maybeSingle(),
    ]);

    const [sellerDirection, buyerDirection] = await Promise.all([
        meAsSeller
            ? supabase.from("buyer_seller_transport_prefs").select("*").eq("buyer_id", otherUserId).eq("seller_id", meAsSeller.id).maybeSingle()
            : Promise.resolve({ data: null }),
        otherAsSeller
            ? supabase.from("buyer_seller_transport_prefs").select("*").eq("buyer_id", req.user.id).eq("seller_id", otherAsSeller.id).maybeSingle()
            : Promise.resolve({ data: null }),
    ]);

    const row = sellerDirection.data || buyerDirection.data || null;
    const viewerRole = sellerDirection.data ? "seller" : buyerDirection.data ? "buyer" : (otherAsSeller ? "buyer" : meAsSeller ? "seller" : null);
    res.json({ success: true, preference: row, viewerRole, sellerUserId: otherAsSeller ? otherUserId : req.user.id });
}

// POST /api/transport/propose  { otherUserId, conversationId, mode, transportCompany, details }
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

    const { data, error } = await supabase.rpc("propose_transport", {
        p_buyer_id: buyerId, p_seller_id: sellerId, p_proposer_id: req.user.id,
        p_conversation_id: conversationId, p_mode: mode, p_transport_company: transportCompany || null, p_details: details || null,
    });
    if (error) return res.status(400).json({ success: false, message: "Couldn't send the proposal." });

    const row = Array.isArray(data) ? data[0] : data;
    const { data: message } = await supabase.from("chat_messages").select("*").eq("id", row.message_id).single();

    res.json({ success: true, prefId: row.pref_id });

    emitToConversation(conversationId, "message:new", { ...message, status: "sent" });
    emitToConversation(conversationId, "transport:proposed", { conversationId, prefId: row.pref_id }, { excludeUserId: req.user.id });

    const otherId = req.user.id === buyerUserId ? sellerUserId : buyerUserId;
    notifyUser(otherId, {
        type: "transport_proposal",
        title: "Transport preference proposed",
        body: `Mode: ${mode}${transportCompany ? ` · ${transportCompany}` : ""}`,
        link: `/chat/${conversationId}`,
    });
}

// POST /api/transport/:id/decide  { decision: 'confirmed' | 'declined' }
export async function decideTransport(req, res) {
    const { decision } = req.body;
    const { error } = await supabase.rpc("decide_transport", {
        p_pref_id: req.params.id, p_deciding_user_id: req.user.id, p_decision: decision,
    });
    if (error) {
        const map = { CANNOT_DECIDE_OWN_PROPOSAL: "You can't accept your own proposal.", NOT_PENDING: "This proposal was already decided." };
        return res.status(400).json({ success: false, code: error.message, message: map[error.message] || "Couldn't record the decision." });
    }

    const { data: pref } = await supabase.from("buyer_seller_transport_prefs").select("*").eq("id", req.params.id).single();
    res.json({ success: true, status: pref.status });

    if (pref?.conversation_id) {
        emitToConversation(pref.conversation_id, "transport:decided", { prefId: pref.id, status: pref.status });
    }
    notifyUser(pref.proposed_by, {
        type: "transport_decision",
        title: decision === "confirmed" ? "Transport preference agreed" : "Transport proposal declined",
        body: decision === "confirmed" ? "Your proposed transport preference was accepted." : "Your transport proposal was declined — try proposing a different one.",
        link: pref.conversation_id ? `/chat/${pref.conversation_id}` : undefined,
    });
}