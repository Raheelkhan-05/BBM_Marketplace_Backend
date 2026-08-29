// controllers/credit.controller.js
import { supabase } from "../config/supabase.js";
import { emitToConversation } from "../socket/emit.js";
import { notifyUser } from "../services/realtimeBroadcast.js";

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

        // A user can be BOTH a seller themselves AND a buyer from someone
        // else — `meAsSeller` being truthy doesn't mean *this* conversation
        // is the one where they're the seller. Check both possible
        // directions and use whichever one actually has a credit row,
        // instead of assuming "has a seller_profiles row" == "is the seller
        // here". This was the actual bug: it always took the seller branch
        // when true, even when the real relationship for this chat was the
        // other direction, silently querying the wrong row forever.
        const [sellerDirection, buyerDirection] = await Promise.all([
            meAsSeller
                ? supabase.from("buyer_seller_credit").select("*").eq("buyer_id", otherUserId).eq("seller_id", meAsSeller.id).maybeSingle()
                : Promise.resolve({ data: null }),
            otherAsSeller
                ? supabase.from("buyer_seller_credit").select("*").eq("buyer_id", req.user.id).eq("seller_id", otherAsSeller.id).maybeSingle()
                : Promise.resolve({ data: null }),
        ]);

        if (sellerDirection.data) {
            return res.json({ success: true, credit: sellerDirection.data, viewerRole: "seller" });
        }
        if (buyerDirection.data) {
            return res.json({ success: true, credit: buyerDirection.data, viewerRole: "buyer" });
        }

        // Neither direction has a row yet (no request has ever been made).
        // Default to whichever direction is actually possible — prefer
        // "buyer" since requesting credit is the more common first action,
        // but only if the other party can even receive one (is a seller).
        if (otherAsSeller) {
            return res.json({ success: true, credit: null, viewerRole: "buyer" });
        }
        if (meAsSeller) {
            return res.json({ success: true, credit: null, viewerRole: "seller" });
        }
        return res.json({ success: true, credit: null, viewerRole: null });
    }

    const { data, error } = await query.maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, credit: data || null, viewerRole });
}

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

    res.json({ success: true, creditId: row.credit_id, conversationId: convId });

    emitToConversation(convId, "message:new", { ...message, status: "sent" });


    // NEW: tell the seller's live thread a credit request just landed, so
    // useCredit doesn't have to wait for a page refresh (its mount-time
    // fetch) to learn about it. credit:decided/credit:toggled already
    // update state live for later transitions — this covers the missing
    // "just created" transition into "pending".
    emitToConversation(convId, "credit:requested", {
        conversationId: convId,
        creditId: row.credit_id,
        buyerId: req.user.id,
        sellerId,
        status: "pending",
    }, { excludeUserId: req.user.id });

    notifyUser(sellerUserId, {
        type: "credit_request",
        title: "New credit request",
        body: `A buyer wants to buy on credit from you.`,
        link: `/chat/${convId}`,
    });
}

export async function decideCredit(req, res) {
    const { decision } = req.body;
    const { error } = await supabase.rpc("decide_credit", {
        p_credit_id: req.params.id, p_seller_user_id: req.user.id, p_decision: decision,
    });
    if (error) return res.status(400).json({ success: false, message: "Couldn't record the decision." });

    const { data: credit } = await supabase.from("buyer_seller_credit").select("*").eq("id", req.params.id).single();

    res.json({ success: true, status: credit.status });

    if (credit?.conversation_id) {
        emitToConversation(credit.conversation_id, "credit:decided", { creditId: credit.id, status: credit.status, cooldownUntil: credit.cooldown_until });
    }
    if (credit?.buyer_id) {
        notifyUser(credit.buyer_id, {
            type: "credit_decision",
            title: decision === "approved" ? "Credit approved" : "Credit request declined",
            body: decision === "approved" ? "You can now buy on credit from this seller." : "Your credit request was declined.",
            link: credit.conversation_id ? `/chat/${credit.conversation_id}` : undefined,
        });
    }
}

export async function toggleCredit(req, res) {
    const { buyerId, enabled } = req.body;
    const { error } = await supabase.rpc("toggle_credit", { p_seller_user_id: req.user.id, p_buyer_id: buyerId, p_enabled: enabled });
    if (error) return res.status(400).json({ success: false, message: "Couldn't update credit status." });

    const { data: sp } = await supabase.from("seller_profiles").select("id").eq("user_id", req.user.id).maybeSingle();
    const { data: credit } = await supabase.from("buyer_seller_credit").select("*").eq("buyer_id", buyerId).eq("seller_id", sp.id).maybeSingle();

    res.json({ success: true, status: enabled ? "approved" : "revoked" });

    if (credit?.conversation_id) {
        emitToConversation(credit.conversation_id, "credit:toggled", { buyerId, status: enabled ? "approved" : "revoked" });
    }
    notifyUser(buyerId, {
        type: "credit_toggled",
        title: enabled ? "Credit enabled" : "Credit turned off",
        body: enabled ? "A seller has enabled buy-on-credit for you." : "A seller has turned off buy-on-credit for you.",
        link: credit?.conversation_id ? `/chat/${credit.conversation_id}` : undefined,
    });
}