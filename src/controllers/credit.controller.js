// controllers/credit.controller.js
import { supabase } from "../config/supabase.js";
import { emitToConversation } from "../socket/emit.js";
import { notifyUser } from "../services/realtimeBroadcast.js";


async function getBuyerInfoForSeller(buyerId) {
    const [{ data: profile }, { data: bp }, { data: sp }] = await Promise.all([
        supabase.from("profiles").select("name, phone, email, created_at").eq("id", buyerId).maybeSingle(),
        supabase.from("business_profiles").select("legal_name, trade_name, gstin, district, state").eq("user_id", buyerId).maybeSingle(),
        supabase.from("seller_profiles").select("logo_url").eq("user_id", buyerId).maybeSingle(), // NEW
    ]);
    if (!profile && !bp) return null;
    return {
        name: profile?.name || null,
        phone: profile?.phone || null,
        email: profile?.email || null,
        memberSince: profile?.created_at || null,
        businessName: bp?.trade_name || bp?.legal_name || null,
        gstin: bp?.gstin || null,
        location: [bp?.district, bp?.state].filter(Boolean).join(", ") || null,
        logoUrl: sp?.logo_url || null, // NEW
    };
}


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
        // controllers/credit.controller.js — getCreditStatus, inside the otherUserId branch
    } else if (otherUserId) {
        const [{ data: meAsSeller }, { data: otherAsSeller }] = await Promise.all([
            supabase.from("seller_profiles").select("id").eq("user_id", req.user.id).maybeSingle(),
            supabase.from("seller_profiles").select("id").eq("user_id", otherUserId).maybeSingle(),
        ]);

        const [sellerDirection, buyerDirection] = await Promise.all([
            meAsSeller
                ? supabase.from("buyer_seller_credit").select("*").eq("buyer_id", otherUserId).eq("seller_id", meAsSeller.id).maybeSingle()
                : Promise.resolve({ data: null }),
            otherAsSeller
                ? supabase.from("buyer_seller_credit").select("*").eq("buyer_id", req.user.id).eq("seller_id", otherAsSeller.id).maybeSingle()
                : Promise.resolve({ data: null }),
        ]);

        if (sellerDirection.data) {
            // NEW — this branch means req.user IS the seller, otherUserId is the buyer
            const buyerInfo = await getBuyerInfoForSeller(otherUserId);
            return res.json({ success: true, credit: sellerDirection.data, viewerRole: "seller", buyerInfo });
        }
        if (buyerDirection.data) {
            return res.json({ success: true, credit: buyerDirection.data, viewerRole: "buyer" });
        }

        // Neither direction has a row yet — still tell a seller-viewer who they'd be
        // approving, even before any request exists, so the UI is consistent
        // whenever a credit row does eventually appear.
        if (otherAsSeller) {
            return res.json({ success: true, credit: null, viewerRole: "buyer" });
        }
        if (meAsSeller) {
            const buyerInfo = await getBuyerInfoForSeller(otherUserId); // NEW
            return res.json({ success: true, credit: null, viewerRole: "seller", buyerInfo });
        }
        return res.json({ success: true, credit: null, viewerRole: null });
    }

    const { data, error } = await query.maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });

    let buyerInfo = null;
    if (viewerRole === "seller" && data) {
        buyerInfo = await getBuyerInfoForSeller(data.buyer_id);
    }
    res.json({ success: true, credit: data || null, viewerRole, buyerInfo });
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
        console.error("request_credit RPC failed:", error);
        const map = {
            ALREADY_APPROVED: "Credit is already approved for this seller.",
            ALREADY_PENDING: "A credit request is already pending.",
            COOLDOWN_ACTIVE: "You can request credit from this seller again after the cooldown period.",
        };
        const code = error.message; // Postgres RAISE EXCEPTION message becomes error.message via the RPC
        return res.status(400).json({
            success: false,
            code: map[code] ? code : "REQUEST_FAILED",
            message: map[code] || "Couldn't send the request. Please try again.",
        });
    }

    const row = Array.isArray(data) ? data[0] : data;
    const { data: message } = await supabase.from("chat_messages").select("*").eq("id", row.message_id).single();

    res.json({ success: true, creditId: row.credit_id, conversationId: convId });

    emitToConversation(convId, "message:new", { ...message, status: "sent" });

    // Freeze the OUTGOING request's final outcome onto its own message before
    // request_message_id moves on to the new one — otherwise the old bubble
    // has no way to distinguish "this was declined" from "this was turned
    // off" from "I have no idea, guess I'll say Sent" once it's no longer
    // the row's live pointer. This reuses the message:updated event/listener
    // that transport_proposal's finalStatus already relies on — no new
    // plumbing needed on the client.
    if (row.previous_message_id && row.previous_status) {
        const { data: prevMsg } = await supabase.from("chat_messages").select("metadata").eq("id", row.previous_message_id).maybeSingle();
        const metadataPatch = { finalStatus: row.previous_status };
        await supabase.from("chat_messages")
            .update({ metadata: { ...(prevMsg?.metadata || {}), ...metadataPatch } })
            .eq("id", row.previous_message_id);
        emitToConversation(convId, "message:updated", { conversationId: convId, messageId: row.previous_message_id, metadataPatch });
    }

    emitToConversation(convId, "credit:requested", {
        conversationId: convId,
        creditId: row.credit_id,
        buyerId: req.user.id,
        sellerId,
        status: "pending",
        buyerInfo: await getBuyerInfoForSeller(req.user.id),
    }, { excludeUserId: req.user.id });

    notifyUser(sellerUserId, {
        type: "credit_request",
        title: "New credit request",
        body: `A buyer wants to buy on credit from you.`,
        link: `/chat/${convId}`,
    });
}

export async function decideCredit(req, res) {
    const { decision, creditLimit } = req.body;
    const { error } = await supabase.rpc("decide_credit", {
        p_credit_id: req.params.id, p_seller_user_id: req.user.id,
        p_decision: decision, p_credit_limit: decision === "approved" ? Number(creditLimit) : null,
    });
    if (error) {
        const map = { CREDIT_LIMIT_REQUIRED: "Please set a credit limit to approve this request." };
        return res.status(400).json({ success: false, message: map[error.message] || "Couldn't record the decision." });
    }

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

// credit.controller.js — before returning to a buyer-viewer
function sanitizeForBuyer(credit) {
    if (!credit) return credit;
    const { credit_limit, credit_used, period_start, ...safe } = credit;
    return safe; // buyer gets status/cooldown/etc, never limit or usage
}

// credit.controller.js — new export
// export async function requestCreditIncrease(req, res) {
//     const { creditId } = req.body;
//     const { data: credit } = await supabase.from("buyer_seller_credit").select("*").eq("id", creditId).eq("buyer_id", req.user.id).maybeSingle();
//     if (!credit || credit.status !== "approved") {
//         return res.status(400).json({ success: false, message: "No active credit arrangement found." });
//     }
//     const { data: msg, error } = await supabase.from("chat_messages").insert({
//         conversation_id: credit.conversation_id, sender_id: req.user.id,
//         body: "Requested a higher credit limit", message_type: "credit_limit_request",
//         metadata: { creditId: credit.id },
//     }).select("*").single();
//     if (error) return res.status(500).json({ success: false, message: error.message });

//     await supabase.from("buyer_seller_credit").update({
//         limit_increase_requested_at: new Date().toISOString(),
//         limit_increase_request_message_id: msg.id,
//     }).eq("id", creditId);

//     res.json({ success: true, conversationId: credit.conversation_id });
//     emitToConversation(credit.conversation_id, "message:new", { ...msg, status: "sent" });
//     notifyUser(/* seller's user id, looked up same way as requestCredit */ {
//         type: "credit_limit_request",
//         title: "Credit limit increase requested",
//         body: "A buyer has asked you to reconsider their credit limit.",
//         link: `/chat/${credit.conversation_id}`,
//     });
// }

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

// credit.controller.js — new export
// REPLACE the existing updateCreditLimit body's post-RPC section with this
// (defensive clear, since we don't know what update_credit_limit RPC itself clears):
export async function updateCreditLimit(req, res) {
    const { newLimit, resetUsed } = req.body;
    const { data: before } = await supabase.from("buyer_seller_credit").select("limit_increase_request_message_id").eq("id", req.params.id).maybeSingle();

    const { error } = await supabase.rpc("update_credit_limit", {
        p_credit_id: req.params.id,
        p_seller_user_id: req.user.id,
        p_new_limit: Number(newLimit),
        p_reset_used: resetUsed !== false,
    });
    if (error) {
        const map = { CREDIT_LIMIT_REQUIRED: "Please enter a valid credit limit." };
        return res.status(400).json({ success: false, message: map[error.message] || "Couldn't update the credit limit." });
    }

    // Defensive: make sure a live limit-increase request doesn't linger as
    // "pending" forever after being approved this way.
    if (before?.limit_increase_request_message_id) {
        await supabase.from("buyer_seller_credit").update({
            limit_increase_requested_at: null,
            limit_increase_request_message_id: null,
        }).eq("id", req.params.id);

        const { data: msg } = await supabase.from("chat_messages").select("metadata").eq("id", before.limit_increase_request_message_id).maybeSingle();
        const metadataPatch = { finalStatus: "approved" };
        await supabase.from("chat_messages").update({ metadata: { ...(msg?.metadata || {}), ...metadataPatch } }).eq("id", before.limit_increase_request_message_id);
    }

    const { data: credit } = await supabase.from("buyer_seller_credit").select("*").eq("id", req.params.id).single();

    res.json({ success: true, credit });

    if (credit?.conversation_id) {
        if (before?.limit_increase_request_message_id) {
            emitToConversation(credit.conversation_id, "message:updated", {
                conversationId: credit.conversation_id, messageId: before.limit_increase_request_message_id, metadataPatch: { finalStatus: "approved" },
            });
        }
        emitToConversation(credit.conversation_id, "credit:decided", { creditId: credit.id, status: credit.status, cooldownUntil: credit.cooldown_until });
    }
    if (credit?.buyer_id) {
        notifyUser(credit.buyer_id, {
            type: "credit_decision", title: "Credit limit updated",
            body: "Your seller has updated your monthly credit limit.",
            link: credit.conversation_id ? `/chat/${credit.conversation_id}` : undefined,
        });
    }
}

// NEW — seller declines a limit-increase ask. Sets a cooldown so the buyer
// can't immediately re-ask, mirroring how decide_credit's rejection cooldown works.
export async function declineCreditIncrease(req, res) {
    const { cooldownDays = 14 } = req.body || {};

    const { data: credit } = await supabase.from("buyer_seller_credit").select("*").eq("id", req.params.id).maybeSingle();
    if (!credit || !credit.limit_increase_request_message_id) {
        return res.status(400).json({ success: false, message: "No pending limit increase request." });
    }

    const { data: sellerProfile } = await supabase.from("seller_profiles").select("user_id").eq("id", credit.seller_id).maybeSingle();
    if (!sellerProfile || sellerProfile.user_id !== req.user.id) {
        return res.status(403).json({ success: false, message: "Not authorized." });
    }

    const cooldownUntil = new Date();
    cooldownUntil.setDate(cooldownUntil.getDate() + Number(cooldownDays));

    const requestMessageId = credit.limit_increase_request_message_id;

    const { error } = await supabase.from("buyer_seller_credit").update({
        limit_increase_requested_at: null,
        limit_increase_request_message_id: null,
        limit_increase_cooldown_until: cooldownUntil.toISOString(),
    }).eq("id", req.params.id);
    if (error) return res.status(500).json({ success: false, message: error.message });

    const { data: msg } = await supabase.from("chat_messages").select("metadata").eq("id", requestMessageId).maybeSingle();
    const metadataPatch = { finalStatus: "rejected" };
    await supabase.from("chat_messages").update({ metadata: { ...(msg?.metadata || {}), ...metadataPatch } }).eq("id", requestMessageId);

    const { data: updated } = await supabase.from("buyer_seller_credit").select("*").eq("id", req.params.id).single();

    res.json({ success: true, credit: updated });

    if (updated?.conversation_id) {
        emitToConversation(updated.conversation_id, "message:updated", { conversationId: updated.conversation_id, messageId: requestMessageId, metadataPatch });
        emitToConversation(updated.conversation_id, "credit:decided", {
            creditId: updated.id, status: updated.status,
            limitIncreaseCooldownUntil: updated.limit_increase_cooldown_until,
        });
    }
    if (updated?.buyer_id) {
        notifyUser(updated.buyer_id, {
            type: "credit_decision", title: "Credit limit request declined",
            body: "Your seller declined your request for a higher credit limit.",
            link: updated.conversation_id ? `/chat/${updated.conversation_id}` : undefined,
        });
    }
}

export async function requestCreditIncrease(req, res) {
    const { creditId } = req.body;
    const { data: credit } = await supabase.from("buyer_seller_credit").select("*").eq("id", creditId).eq("buyer_id", req.user.id).maybeSingle();
    if (!credit || credit.status !== "approved") {
        return res.status(400).json({ success: false, message: "No active credit arrangement found." });
    }

    // NEW — only one live increase request at a time, and respect the cooldown after a decline
    if (credit.limit_increase_request_message_id) {
        return res.status(400).json({ success: false, code: "INCREASE_ALREADY_PENDING", message: "A request for a higher limit is already pending." });
    }
    if (credit.limit_increase_cooldown_until && new Date(credit.limit_increase_cooldown_until) > new Date()) {
        return res.status(400).json({ success: false, code: "INCREASE_COOLDOWN_ACTIVE", message: "You can ask for a higher limit again after the cooldown period." });
    }

    // NEW — resolve the seller's user_id so we know who to notify
    const { data: sellerProfile } = await supabase.from("seller_profiles").select("user_id").eq("id", credit.seller_id).maybeSingle();
    if (!sellerProfile) {
        return res.status(400).json({ success: false, message: "Couldn't find the seller for this credit arrangement." });
    }

    const { data: msg, error } = await supabase.from("chat_messages").insert({
        conversation_id: credit.conversation_id, sender_id: req.user.id,
        body: "Requested a higher credit limit", message_type: "credit_limit_request",
        metadata: { creditId: credit.id },
    }).select("*").single();
    if (error) return res.status(500).json({ success: false, message: error.message });

    await supabase.from("buyer_seller_credit").update({
        limit_increase_requested_at: new Date().toISOString(),
        limit_increase_request_message_id: msg.id,
    }).eq("id", creditId);

    res.json({ success: true, conversationId: credit.conversation_id });

    emitToConversation(credit.conversation_id, "message:new", { ...msg, status: "sent" });
    notifyUser(sellerProfile.user_id, {
        type: "credit_limit_request",
        title: "Credit limit increase requested",
        body: "A buyer has asked you to reconsider their credit limit.",
        link: `/chat/${credit.conversation_id}`,
    });
}