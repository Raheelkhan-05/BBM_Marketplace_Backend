// controllers/credit.controller.js
import { supabase } from "../config/supabase.js";
import { emitToConversation } from "../socket/emit.js";

// GET /api/credit/status
// Three ways to call it:
//   ?sellerId=<seller_profiles.id>        — buyer's perspective (BuyNowModal, where sellerId is already known)
//   ?buyerId=<profiles.id>                — seller's perspective, resolves seller_profiles.id from req.user
//   ?otherUserId=<profiles.id>            — role-agnostic (chat), server figures out who's who
export async function getCreditStatus(req, res) {
    const { sellerId, submissionId, buyerId, otherUserId } = req.query;
    let query = supabase.from("buyer_seller_credit").select("*");
    let viewerRole = null;

    let resolvedSellerId = sellerId;
    if (!resolvedSellerId && submissionId) {
        const { data: sub } = await supabase.from("seller_product_submissions").select("seller_id").eq("id", submissionId).maybeSingle();
        if (!sub) return res.status(404).json({ success: false, message: "Listing not found." });
        resolvedSellerId = sub.seller_id;
    }
    if (resolvedSellerId) {
        query = query.eq("buyer_id", req.user.id).eq("seller_id", resolvedSellerId);
        viewerRole = "buyer";
    } else if (buyerId) {
        const { data: sp } = await supabase.from("seller_profiles").select("id").eq("user_id", req.user.id).maybeSingle();
        if (!sp) return res.status(403).json({ success: false, message: "Not a seller." });
        query = query.eq("buyer_id", buyerId).eq("seller_id", sp.id);
        viewerRole = "seller";
    } else if (otherUserId) {
        const [{ data: meAsSeller }, { data: otherAsSeller }] = await Promise.all([
            supabase.from("seller_profiles").select("id").eq("user_id", req.user.id).maybeSingle(),
            supabase.from("seller_profiles").select("id").eq("user_id", otherUserId).maybeSingle(),
        ]);
        if (meAsSeller) {
            query = query.eq("buyer_id", otherUserId).eq("seller_id", meAsSeller.id);
            viewerRole = "seller";
        } else if (otherAsSeller) {
            query = query.eq("buyer_id", req.user.id).eq("seller_id", otherAsSeller.id);
            viewerRole = "buyer";
        } else {
            return res.json({ success: true, credit: null, viewerRole: null });
        }
    } else {
        return res.status(400).json({ success: false, message: "sellerId, submissionId, buyerId, or otherUserId is required." });
    }

    const { data, error } = await query.maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, credit: data || null, viewerRole });
}

// POST /api/credit/request
// Accepts any ONE of: sellerId (seller_profiles.id), submissionId (listing id),
// or sellerUserId (seller's profiles.id) — resolves the other two from whichever is given.
// conversationId is optional; if omitted, finds-or-creates the buyer<->seller direct chat.
export async function requestCredit(req, res) {
    let { sellerId, submissionId, sellerUserId, conversationId } = req.body;

    if (!sellerId && submissionId) {
        const { data: sub } = await supabase.from("seller_product_submissions").select("seller_id").eq("id", submissionId).maybeSingle();
        if (!sub) return res.status(404).json({ success: false, message: "Listing not found." });
        sellerId = sub.seller_id;
    }
    if (!sellerId && sellerUserId) {
        const { data: sp } = await supabase.from("seller_profiles").select("id").eq("user_id", sellerUserId).maybeSingle();
        if (!sp) return res.status(400).json({ success: false, message: "That user isn't a seller." });
        sellerId = sp.id;
    }
    if (!sellerUserId && sellerId) {
        const { data: sp } = await supabase.from("seller_profiles").select("user_id").eq("id", sellerId).maybeSingle();
        if (sp) sellerUserId = sp.user_id;
    }
    if (!sellerId || !sellerUserId) {
        return res.status(400).json({ success: false, message: "Couldn't identify the seller." });
    }
    if (sellerUserId === req.user.id) {
        return res.status(400).json({ success: false, code: "CANNOT_REQUEST_OWN_LISTING", message: "You can't request credit on your own listing." });
    }

    let convId = conversationId;
    if (!convId) {
        const [a, b] = [req.user.id, sellerUserId].sort();
        const { data: existing } = await supabase.from("chat_conversations").select("id").eq("is_group", false).eq("direct_user_a", a).eq("direct_user_b", b).maybeSingle();
        if (existing) {
            convId = existing.id;
        } else {
            const { data: created, error: createErr } = await supabase.from("chat_conversations").insert({ is_group: false, direct_user_a: a, direct_user_b: b }).select("id").single();
            if (createErr) return res.status(500).json({ success: false, message: createErr.message });
            await supabase.from("chat_participants").insert([{ conversation_id: created.id, user_id: a }, { conversation_id: created.id, user_id: b }]);
            convId = created.id;
        }
    }

    const { data, error } = await supabase.rpc("request_credit", {
        p_buyer_id: req.user.id, p_seller_id: sellerId, p_conversation_id: convId,
    });
    if (error) {
        const map = {
            ALREADY_APPROVED: "Credit is already approved for this seller.",
            ALREADY_PENDING: "A credit request is already pending.",
            COOLDOWN_ACTIVE: "You can request credit from this seller again after the cooldown period.",
        };
        return res.status(400).json({ success: false, code: error.message, message: map[error.message] || "Couldn't send the request." });
    }

    const row = Array.isArray(data) ? data[0] : data;
    const { data: message } = await supabase.from("chat_messages").select("*").eq("id", row.message_id).single();
    await emitToConversation(convId, "message:new", { ...message, status: "sent" });

    res.json({ success: true, creditId: row.credit_id, conversationId: convId });
}

// POST /api/credit/:id/decide  { decision: "approved" | "rejected" }
export async function decideCredit(req, res) {
    const { decision } = req.body;
    const { error } = await supabase.rpc("decide_credit", {
        p_credit_id: req.params.id, p_seller_user_id: req.user.id, p_decision: decision,
    });
    if (error) return res.status(400).json({ success: false, message: "Couldn't record the decision." });

    const { data: credit } = await supabase.from("buyer_seller_credit").select("*").eq("id", req.params.id).single();
    if (credit?.conversation_id) {
        await emitToConversation(credit.conversation_id, "credit:decided", { creditId: credit.id, status: credit.status, cooldownUntil: credit.cooldown_until });
    }
    res.json({ success: true, status: credit.status });
}

// POST /api/credit/toggle  { buyerId, enabled }  — seller-only, from the chat pinned bar
export async function toggleCredit(req, res) {
    const { buyerId, enabled } = req.body;
    const { error } = await supabase.rpc("toggle_credit", { p_seller_user_id: req.user.id, p_buyer_id: buyerId, p_enabled: enabled });
    if (error) return res.status(400).json({ success: false, message: "Couldn't update credit status." });

    const { data: sp } = await supabase.from("seller_profiles").select("id").eq("user_id", req.user.id).maybeSingle();
    const { data: credit } = await supabase.from("buyer_seller_credit").select("*").eq("buyer_id", buyerId).eq("seller_id", sp.id).maybeSingle();
    if (credit?.conversation_id) {
        await emitToConversation(credit.conversation_id, "credit:toggled", { buyerId, status: enabled ? "approved" : "revoked" });
    }
    res.json({ success: true, status: enabled ? "approved" : "revoked" });
}