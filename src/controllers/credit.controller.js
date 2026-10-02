// controllers/credit.controller.js
import { supabase } from "../config/supabase.js";
import { emitToConversation } from "../socket/emit.js";
import { invalidateParticipants } from "../socket/participantsCache.js";
import { notifyUser } from "../services/realtimeBroadcast.js";
import { trackCreditEvent } from "../services/creditEvents.js";

// Every credit notification deep-links into the Credit page: the right tab,
// scrolled to and highlighted on the exact record (see CreditPage.jsx).
//   tab: "requests" (seller inbox) | "approved" | "sellers"
const creditLink = (tab, creditId) =>
    creditId ? `/credit?tab=${tab}&highlight=${creditId}` : `/credit?tab=${tab}`;

// ---- helpers ------------------------------------------------------------

function buyerLabelOf(bp) {
    return bp?.display_name?.trim() || bp?.trade_name?.trim() || bp?.legal_name?.trim() || null;
}

// Batched: one round of 3 queries for any number of buyers.
async function getBuyerInfoMap(buyerIds) {
    const ids = [...new Set((buyerIds || []).filter(Boolean))];
    const map = new Map();
    if (!ids.length) return map;

    const [{ data: profiles }, { data: bps }, { data: sps }] = await Promise.all([
        supabase.from("profiles").select("id, name, phone, email, created_at").in("id", ids),
        supabase.from("business_profiles").select("user_id, display_name, legal_name, trade_name, gstin, district, state").in("user_id", ids),
        supabase.from("seller_profiles").select("user_id, logo_url").in("user_id", ids),
    ]);
    const pById = new Map((profiles || []).map((p) => [p.id, p]));
    const bpById = new Map((bps || []).map((p) => [p.user_id, p]));
    const spById = new Map((sps || []).map((p) => [p.user_id, p]));

    for (const id of ids) {
        const profile = pById.get(id);
        const bp = bpById.get(id);
        const sp = spById.get(id);
        if (!profile && !bp) continue;
        map.set(id, {
            name: profile?.name || null,
            phone: profile?.phone || null,
            email: profile?.email || null,
            memberSince: profile?.created_at || null,
            businessName: buyerLabelOf(bp),
            gstin: bp?.gstin || null,
            location: [bp?.district, bp?.state].filter(Boolean).join(", ") || null,
            logoUrl: sp?.logo_url || null,
        });
    }
    return map;
}

async function getBuyerInfoForSeller(buyerId) {
    const map = await getBuyerInfoMap([buyerId]);
    return map.get(buyerId) || null;
}

// What a buyer is allowed to see about their own credit row.
function pickBuyerCredit(c) {
    if (!c) return null;
    return {
        id: c.id,
        status: c.status,
        credit_limit: c.credit_limit,
        credit_used: c.credit_used,
        cooldown_until: c.cooldown_until,
        limit_increase_request_message_id: c.limit_increase_request_message_id,
        limit_increase_cooldown_until: c.limit_increase_cooldown_until,
        conversation_id: c.conversation_id,
    };
}

// Finds (or creates) the 1:1 chat between two users and returns its id.
async function ensureDirectConversation(userA, userB) {
    const [a, b] = [userA, userB].sort();
    const { data: existing } = await supabase
        .from("chat_conversations").select("id")
        .eq("is_group", false).eq("direct_user_a", a).eq("direct_user_b", b)
        .maybeSingle();
    if (existing) return existing.id;

    const { data: created, error: createErr } = await supabase
        .from("chat_conversations")
        .insert({ is_group: false, direct_user_a: a, direct_user_b: b })
        .select("id").single();
    if (createErr) throw createErr;

    const { error: partErr } = await supabase
        .from("chat_participants")
        .insert([{ conversation_id: created.id, user_id: a }, { conversation_id: created.id, user_id: b }]);
    if (partErr) throw partErr;

    invalidateParticipants(created.id);
    return created.id;
}

// A buyer the seller can proactively extend credit to: a real, finished,
// fully-verified, non-deleted user account. Used by BOTH search and grant so
// the rules can never drift apart.
function eligibleBuyers(selectCols, excludeUserId) {
    return supabase
        .from("profiles")
        .select(selectCols)
        .eq("role", "user")
        .eq("phone_verified", true)
        .eq("email_verified", true)
        .eq("onboarding_step", "done")
        .is("deleted_at", null)
        .neq("id", excludeUserId);
}

const maskEmail = (e) => {
    if (!e || !e.includes("@")) return null;
    const [user, domain] = e.split("@");
    return `${user.slice(0, 2)}${"*".repeat(Math.max(user.length - 2, 1))}@${domain}`;
};
const maskPhone = (p) => (p ? `${"*".repeat(Math.max(p.length - 4, 0))}${p.slice(-4)}` : null);

// ---- GET /api/credit/status (unchanged; still used by chat + BuyNowModal) ---
// Three ways to call it:
//   ?sellerId=<seller_profiles.id>        — buyer's perspective
//   ?buyerId=<profiles.id>                — seller's perspective
//   ?otherUserId=<profiles.id>            — role-agnostic, server figures out who's who
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

        const [sellerDirection, buyerDirection] = await Promise.all([
            meAsSeller
                ? supabase.from("buyer_seller_credit").select("*").eq("buyer_id", otherUserId).eq("seller_id", meAsSeller.id).maybeSingle()
                : Promise.resolve({ data: null }),
            otherAsSeller
                ? supabase.from("buyer_seller_credit").select("*").eq("buyer_id", req.user.id).eq("seller_id", otherAsSeller.id).maybeSingle()
                : Promise.resolve({ data: null }),
        ]);

        if (sellerDirection.data) {
            const buyerInfo = await getBuyerInfoForSeller(otherUserId);
            return res.json({ success: true, credit: sellerDirection.data, viewerRole: "seller", buyerInfo });
        }
        if (buyerDirection.data) {
            return res.json({ success: true, credit: buyerDirection.data, viewerRole: "buyer" });
        }
        if (meAsSeller) {
            const buyerInfo = await getBuyerInfoForSeller(otherUserId);
            return res.json({ success: true, credit: null, viewerRole: "seller", buyerInfo });
        }
        if (otherAsSeller) {
            return res.json({ success: true, credit: null, viewerRole: "buyer" });
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

// ---- Credit page data ------------------------------------------------------

// GET /api/credit/sellers — every approved seller EXCEPT the caller's own
// shop, each with the caller's credit state (if any) as a buyer.
export async function listCreditSellers(req, res) {
    const myId = req.user.id;
    const [{ data: sellers, error }, { data: credits, error: cErr }] = await Promise.all([
        supabase.from("seller_profiles")
            .select("id, user_id, display_name, logo_url")
            .eq("status", "approved")
            .neq("user_id", myId)
            .is("deleted_at", null)
            .order("display_name", { ascending: true }),
        supabase.from("buyer_seller_credit").select("*").eq("buyer_id", myId),
    ]);
    if (error || cErr) return res.status(500).json({ success: false, message: (error || cErr).message });

    const bySeller = new Map((credits || []).map((c) => [c.seller_id, c]));
    res.json({
        success: true,
        sellers: (sellers || []).map((s) => ({
            sellerId: s.id,
            sellerUserId: s.user_id,
            shopName: s.display_name,
            logoUrl: s.logo_url || null,
            credit: pickBuyerCredit(bySeller.get(s.id)),
        })),
    });
}

// GET /api/credit/incoming — seller-only: every buyer's credit row on this
// seller's shop, with buyer identity. Non-sellers get isSeller:false.
export async function listCreditRequests(req, res) {
    const myId = req.user.id;
    const { data: sp } = await supabase
        .from("seller_profiles").select("id")
        .eq("user_id", myId).eq("status", "approved").is("deleted_at", null)
        .maybeSingle();
    if (!sp) return res.json({ success: true, isSeller: false, requests: [] });

    const { data: credits, error } = await supabase.from("buyer_seller_credit").select("*").eq("seller_id", sp.id);
    if (error) return res.status(500).json({ success: false, message: error.message });

    const infoMap = await getBuyerInfoMap((credits || []).map((c) => c.buyer_id));
    res.json({
        success: true,
        isSeller: true,
        requests: (credits || []).map((c) => ({ credit: c, buyerInfo: infoMap.get(c.buyer_id) || null })),
    });
}

// GET /api/credit/history?as=buyer|seller&before=<created_at>&limit=30
// Both sides' actions on every credit relationship the caller is part of.
export async function listCreditHistory(req, res) {
    const myId = req.user.id;
    const as = req.query.as;
    const before = req.query.before;
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);

    let q = supabase.from("credit_events").select("*").order("created_at", { ascending: false }).limit(limit + 1);
    if (as === "buyer") q = q.eq("buyer_id", myId);
    else if (as === "seller") q = q.eq("seller_user_id", myId);
    else q = q.or(`buyer_id.eq.${myId},seller_user_id.eq.${myId}`);
    if (before) q = q.lt("created_at", before);

    const { data, error } = await q;
    if (error) return res.status(500).json({ success: false, message: error.message });

    const hasMore = (data || []).length > limit;
    const rows = (data || []).slice(0, limit);

    const sellerIds = [...new Set(rows.filter((r) => r.buyer_id === myId).map((r) => r.seller_id))];
    const buyerIds = [...new Set(rows.filter((r) => r.seller_user_id === myId).map((r) => r.buyer_id))];
    const [sellerRes, buyerMap] = await Promise.all([
        sellerIds.length
            ? supabase.from("seller_profiles").select("id, display_name").in("id", sellerIds)
            : Promise.resolve({ data: [] }),
        getBuyerInfoMap(buyerIds),
    ]);
    const sellerName = new Map((sellerRes.data || []).map((s) => [s.id, s.display_name]));

    const events = rows.map((r) => {
        const myRole = r.buyer_id === myId ? "buyer" : "seller";
        const counterpartName = myRole === "buyer"
            ? (sellerName.get(r.seller_id) || null)
            : (buyerMap.get(r.buyer_id)?.businessName || buyerMap.get(r.buyer_id)?.name || null);
        return {
            id: r.id,
            creditId: r.credit_id,
            eventType: r.event_type,
            actorRole: r.actor_role,
            actorIsMe: r.actor_id === myId,
            myRole,
            creditLimit: r.credit_limit == null ? null : Number(r.credit_limit),
            counterpartName,
            createdAt: r.created_at, // returned verbatim: it is also the paging cursor
        };
    });

    res.json({ success: true, events, hasMore });
}

// ---- seller: find a buyer to approve directly ----------------------------

// GET /api/credit/buyers/search?q=<phone | email | shop name>
// Seller-only. Only real, finished, fully-verified, non-deleted accounts
// are ever returned. Contact details are masked in the response.
export async function searchCreditBuyers(req, res) {
    const myId = req.user.id;

    const { data: sp } = await supabase
        .from("seller_profiles").select("id")
        .eq("user_id", myId).eq("status", "approved").is("deleted_at", null)
        .maybeSingle();
    if (!sp) return res.status(403).json({ success: false, message: "Only approved sellers can search for buyers." });

    // Strip characters that have meaning inside PostgREST filters / LIKE patterns.
    const term = String(req.query.q || "").slice(0, 80).replace(/[%,()\\*]/g, " ").replace(/\s+/g, " ").trim();
    if (term.length < 3) return res.json({ success: true, buyers: [] });

    const digits = term.replace(/\D/g, "");
    const phoneLike = /^[\d\s+\-]+$/.test(term) && digits.length >= 3;

    let ids = [];
    try {
        if (phoneLike) {
            // Accept "+91 98765…" / "91987…" by matching on the trailing 10 digits.
            const phoneTerm = digits.length >= 12 && digits.startsWith("91") ? digits.slice(2) : digits;
            const { data, error } = await eligibleBuyers("id", myId).ilike("phone", `%${phoneTerm}%`).limit(10);
            if (error) throw error;
            ids = (data || []).map((p) => p.id);
        } else {
            const [byEmail, byBusiness] = await Promise.all([
                eligibleBuyers("id", myId).ilike("email", `%${term}%`).limit(10),
                supabase.from("business_profiles")
                    .select("user_id")
                    .or(`display_name.ilike.%${term}%,legal_name.ilike.%${term}%,trade_name.ilike.%${term}%`)
                    .limit(30),
            ]);
            if (byEmail.error) throw byEmail.error;
            if (byBusiness.error) throw byBusiness.error;

            const businessUserIds = [...new Set((byBusiness.data || []).map((b) => b.user_id).filter(Boolean))];
            let businessEligible = [];
            if (businessUserIds.length) {
                // Re-apply the eligibility rules to the business matches.
                const { data, error } = await eligibleBuyers("id", myId).in("id", businessUserIds).limit(20);
                if (error) throw error;
                businessEligible = data || [];
            }
            ids = [...new Set([...(byEmail.data || []).map((p) => p.id), ...businessEligible.map((p) => p.id)])];
        }
    } catch (e) {
        console.error("[credit] buyer search failed:", e.message);
        return res.status(500).json({ success: false, message: "Search failed. Please try again." });
    }

    if (!ids.length) return res.json({ success: true, buyers: [] });

    const [infoMap, { data: credits }] = await Promise.all([
        getBuyerInfoMap(ids),
        supabase.from("buyer_seller_credit").select("*").eq("seller_id", sp.id).in("buyer_id", ids),
    ]);
    const creditByBuyer = new Map((credits || []).map((c) => [c.buyer_id, c]));

    const buyers = ids
        .map((id) => {
            const info = infoMap.get(id);
            if (!info) return null;
            const c = creditByBuyer.get(id);
            return {
                buyerId: id,
                name: info.name,
                businessName: info.businessName,
                location: info.location,
                logoUrl: info.logoUrl,
                // phone: maskPhone(info.phone),
                // email: maskEmail(info.email),
                phone: info.phone,
                email: info.email,
                credit: c
                    ? { id: c.id, status: c.status, credit_limit: c.credit_limit, credit_used: c.credit_used }
                    : null,
            };
        })
        .filter(Boolean)
        .sort((a, b) => (a.businessName || a.name || "").localeCompare(b.businessName || b.name || ""))
        .slice(0, 10);

    res.json({ success: true, buyers });
}

// POST /api/credit/grant  { buyerId, creditLimit }
// Seller approves a buyer directly, without the buyer having asked first.
export async function grantCredit(req, res) {
    const { buyerId, creditLimit } = req.body || {};
    const limit = Number(creditLimit);
    if (!buyerId || !(limit > 0)) {
        return res.status(400).json({ success: false, message: "Pick a buyer and set a credit limit." });
    }
    if (buyerId === req.user.id) {
        return res.status(400).json({ success: false, message: "You can't give credit to your own shop." });
    }

    const { data: sp } = await supabase
        .from("seller_profiles").select("id")
        .eq("user_id", req.user.id).eq("status", "approved").is("deleted_at", null)
        .maybeSingle();
    if (!sp) return res.status(403).json({ success: false, message: "Only approved sellers can grant credit." });

    // Same eligibility rules as search — never trust the client's pick.
    const { data: buyer } = await eligibleBuyers("id", req.user.id).eq("id", buyerId).maybeSingle();
    if (!buyer) {
        return res.status(400).json({ success: false, code: "BUYER_NOT_ELIGIBLE", message: "This buyer isn't available for credit." });
    }

    const { data: existing } = await supabase
        .from("buyer_seller_credit").select("*")
        .eq("buyer_id", buyerId).eq("seller_id", sp.id)
        .maybeSingle();

    if (existing?.status === "approved") {
        return res.status(409).json({
            success: false, code: "ALREADY_APPROVED",
            message: "Credit is already approved for this buyer. Use \"Change limit\" to adjust it.",
        });
    }

    let creditId;
    let conversationId = existing?.conversation_id || null;

    if (existing?.status === "pending") {
        // The buyer already asked — resolve it the normal way (updates their chat card too).
        const { error } = await supabase.rpc("decide_credit", {
            p_credit_id: existing.id, p_seller_user_id: req.user.id,
            p_decision: "approved", p_credit_limit: limit,
        });
        if (error) {
            console.error("grantCredit decide_credit failed:", error);
            return res.status(400).json({ success: false, message: "Couldn't approve this buyer. Please try again." });
        }
        creditId = existing.id;
    } else {
        try {
            if (!conversationId) conversationId = await ensureDirectConversation(req.user.id, buyerId);
        } catch (e) {
            console.error("grantCredit conversation failed:", e.message);
            return res.status(500).json({ success: false, message: "Couldn't set up the chat with this buyer." });
        }

        const patch = {
            status: "approved",
            credit_limit: limit,
            credit_used: 0,
            cooldown_until: null,
            limit_increase_requested_at: null,
            limit_increase_request_message_id: null,
            limit_increase_cooldown_until: null,
            conversation_id: conversationId,
        };

        if (existing) {
            // Previously declined or turned off — re-approve with a fresh limit.
            const { error } = await supabase.from("buyer_seller_credit").update(patch).eq("id", existing.id);
            if (error) {
                console.error("grantCredit update failed:", error);
                return res.status(500).json({ success: false, message: "Couldn't approve this buyer. Please try again." });
            }
            creditId = existing.id;
        } else {
            const { data: created, error } = await supabase
                .from("buyer_seller_credit")
                .insert({ buyer_id: buyerId, seller_id: sp.id, ...patch })
                .select("id").single();
            if (error) {
                console.error("grantCredit insert failed:", error);
                return res.status(500).json({ success: false, message: "Couldn't approve this buyer. Please try again." });
            }
            creditId = created.id;
        }
    }

    await trackCreditEvent({
        creditId, buyerId, sellerId: sp.id, sellerUserId: req.user.id,
        actorId: req.user.id, actorRole: "seller", eventType: "approved", creditLimit: limit,
    });

    res.json({ success: true, creditId, status: "approved" });

    if (conversationId) {
        emitToConversation(conversationId, "credit:decided", { creditId, status: "approved", cooldownUntil: null });
    }
    notifyUser(buyerId, {
        type: "credit_decision",
        title: "Credit approved",
        body: "A seller has approved you to buy on credit.",
        link: creditLink("approved", creditId),
    });
}

// ---- buyer asks ---------------------------------------------------------

export async function requestCredit(req, res) {
    let { sellerId, submissionId, sellerUserId, conversationId } = req.body;

    if (!sellerId && submissionId) {
        const { data: sub } = await supabase.from("seller_product_submissions").select("seller_id").eq("id", submissionId).maybeSingle();
        if (!sub) return res.status(404).json({ success: false, message: "Listing not found." });
        sellerId = sub.seller_id;
    }

    let sp = null;
    if (sellerId) {
        ({ data: sp } = await supabase.from("seller_profiles").select("id, user_id, deleted_at").eq("id", sellerId).maybeSingle());
    } else if (sellerUserId) {
        ({ data: sp } = await supabase.from("seller_profiles").select("id, user_id, deleted_at").eq("user_id", sellerUserId).maybeSingle());
        if (!sp) return res.status(400).json({ success: false, message: "That user isn't a seller." });
    }
    if (!sp) return res.status(400).json({ success: false, message: "Couldn't identify the seller." });
    if (sp.deleted_at) return res.status(400).json({ success: false, message: "This seller's account is no longer active." });

    sellerId = sp.id;
    sellerUserId = sp.user_id;

    if (sellerUserId === req.user.id) {
        return res.status(400).json({ success: false, code: "CANNOT_REQUEST_OWN_LISTING", message: "You can't request credit on your own shop." });
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
            const { error: partErr } = await supabase.from("chat_participants").insert([{ conversation_id: created.id, user_id: a }, { conversation_id: created.id, user_id: b }]);
            if (partErr) return res.status(500).json({ success: false, message: partErr.message });
            invalidateParticipants(created.id);
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
        const code = error.message;
        return res.status(400).json({
            success: false,
            code: map[code] ? code : "REQUEST_FAILED",
            message: map[code] || "Couldn't send the request. Please try again.",
        });
    }

    const row = Array.isArray(data) ? data[0] : data;

    await trackCreditEvent({
        creditId: row.credit_id, buyerId: req.user.id, sellerId, sellerUserId,
        actorId: req.user.id, actorRole: "buyer", eventType: "requested",
    });

    res.json({ success: true, creditId: row.credit_id, conversationId: convId });

    // The RPC also drops a marker message into the chat; keep the live chat in sync.
    if (row.message_id) {
        const { data: message } = await supabase.from("chat_messages").select("*").eq("id", row.message_id).maybeSingle();
        if (message) emitToConversation(convId, "message:new", { ...message, status: "sent" });
    }

    // Freeze the previous request's outcome on its own chat message.
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
        body: "A buyer wants to buy on credit from you.",
        link: creditLink("requests", row.credit_id),
    });
}

export async function requestCreditIncrease(req, res) {
    const { creditId } = req.body;
    const { data: credit } = await supabase.from("buyer_seller_credit").select("*").eq("id", creditId).eq("buyer_id", req.user.id).maybeSingle();
    if (!credit || credit.status !== "approved") {
        return res.status(400).json({ success: false, message: "No active credit arrangement found." });
    }
    if (credit.limit_increase_request_message_id) {
        return res.status(400).json({ success: false, code: "INCREASE_ALREADY_PENDING", message: "A request for a higher limit is already pending." });
    }
    if (credit.limit_increase_cooldown_until && new Date(credit.limit_increase_cooldown_until) > new Date()) {
        return res.status(400).json({ success: false, code: "INCREASE_COOLDOWN_ACTIVE", message: "You can ask for a higher limit again after the cooldown period." });
    }

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

    await trackCreditEvent({
        creditId: credit.id, buyerId: credit.buyer_id, sellerId: credit.seller_id, sellerUserId: sellerProfile.user_id,
        actorId: req.user.id, actorRole: "buyer", eventType: "limit_increase_requested",
    });

    res.json({ success: true, conversationId: credit.conversation_id });

    emitToConversation(credit.conversation_id, "message:new", { ...msg, status: "sent" });
    notifyUser(sellerProfile.user_id, {
        type: "credit_limit_request",
        title: "Credit limit increase requested",
        body: "A buyer has asked you to reconsider their credit limit.",
        link: creditLink("requests", credit.id),
    });
}

// ---- seller decides -----------------------------------------------------

export async function decideCredit(req, res) {
    const { decision, creditLimit } = req.body;
    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ success: false, message: "Invalid decision." });
    }
    const limit = decision === "approved" ? Number(creditLimit) : null;
    if (decision === "approved" && !(limit > 0)) {
        return res.status(400).json({ success: false, message: "Please set a credit limit to approve this request." });
    }

    const { error } = await supabase.rpc("decide_credit", {
        p_credit_id: req.params.id, p_seller_user_id: req.user.id,
        p_decision: decision, p_credit_limit: limit,
    });
    if (error) {
        const map = { CREDIT_LIMIT_REQUIRED: "Please set a credit limit to approve this request." };
        return res.status(400).json({ success: false, message: map[error.message] || "Couldn't record the decision." });
    }

    const { data: credit } = await supabase.from("buyer_seller_credit").select("*").eq("id", req.params.id).maybeSingle();
    if (!credit) return res.status(404).json({ success: false, message: "Credit request not found." });

    await trackCreditEvent({
        creditId: credit.id, buyerId: credit.buyer_id, sellerId: credit.seller_id, sellerUserId: req.user.id,
        actorId: req.user.id, actorRole: "seller", eventType: decision, creditLimit: limit,
    });

    res.json({ success: true, status: credit.status });

    if (credit.conversation_id) {
        emitToConversation(credit.conversation_id, "credit:decided", { creditId: credit.id, status: credit.status, cooldownUntil: credit.cooldown_until });
    }
    notifyUser(credit.buyer_id, {
        type: "credit_decision",
        title: decision === "approved" ? "Credit approved" : "Credit request declined",
        body: decision === "approved" ? "You can now buy on credit from this seller." : "Your credit request was declined.",
        link: creditLink(decision === "approved" ? "approved" : "sellers", credit.id),
    });
}

export async function toggleCredit(req, res) {
    const { buyerId, enabled } = req.body;
    if (!buyerId || typeof enabled !== "boolean") {
        return res.status(400).json({ success: false, message: "Invalid request." });
    }
    const { data: sp } = await supabase.from("seller_profiles").select("id").eq("user_id", req.user.id).maybeSingle();
    if (!sp) return res.status(403).json({ success: false, message: "Not a seller." });

    const { error } = await supabase.rpc("toggle_credit", { p_seller_user_id: req.user.id, p_buyer_id: buyerId, p_enabled: enabled });
    if (error) return res.status(400).json({ success: false, message: "Couldn't update credit status." });

    const { data: credit } = await supabase.from("buyer_seller_credit").select("*").eq("buyer_id", buyerId).eq("seller_id", sp.id).maybeSingle();

    if (credit) {
        await trackCreditEvent({
            creditId: credit.id, buyerId, sellerId: sp.id, sellerUserId: req.user.id,
            actorId: req.user.id, actorRole: "seller", eventType: enabled ? "enabled" : "revoked",
        });
    }

    res.json({ success: true, status: enabled ? "approved" : "revoked" });

    if (credit?.conversation_id) {
        emitToConversation(credit.conversation_id, "credit:toggled", { buyerId, status: enabled ? "approved" : "revoked" });
    }
    notifyUser(buyerId, {
        type: "credit_toggled",
        title: enabled ? "Credit enabled" : "Credit turned off",
        body: enabled ? "A seller has enabled buy-on-credit for you." : "A seller has turned off buy-on-credit for you.",
        link: creditLink(enabled ? "approved" : "sellers", credit?.id),
    });
}

export async function updateCreditLimit(req, res) {
    const { newLimit, resetUsed } = req.body;
    if (!(Number(newLimit) > 0)) {
        return res.status(400).json({ success: false, message: "Please enter a valid credit limit." });
    }
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

    // Make sure a live limit-increase request doesn't linger as "pending".
    if (before?.limit_increase_request_message_id) {
        await supabase.from("buyer_seller_credit").update({
            limit_increase_requested_at: null,
            limit_increase_request_message_id: null,
        }).eq("id", req.params.id);

        const { data: msg } = await supabase.from("chat_messages").select("metadata").eq("id", before.limit_increase_request_message_id).maybeSingle();
        await supabase.from("chat_messages")
            .update({ metadata: { ...(msg?.metadata || {}), finalStatus: "approved" } })
            .eq("id", before.limit_increase_request_message_id);
    }

    const { data: credit } = await supabase.from("buyer_seller_credit").select("*").eq("id", req.params.id).maybeSingle();
    if (!credit) return res.status(404).json({ success: false, message: "Credit record not found." });

    await trackCreditEvent({
        creditId: credit.id, buyerId: credit.buyer_id, sellerId: credit.seller_id, sellerUserId: req.user.id,
        actorId: req.user.id, actorRole: "seller", eventType: "limit_updated", creditLimit: Number(newLimit),
    });

    res.json({ success: true, credit });

    if (credit.conversation_id) {
        if (before?.limit_increase_request_message_id) {
            emitToConversation(credit.conversation_id, "message:updated", {
                conversationId: credit.conversation_id, messageId: before.limit_increase_request_message_id, metadataPatch: { finalStatus: "approved" },
            });
        }
        emitToConversation(credit.conversation_id, "credit:decided", { creditId: credit.id, status: credit.status, cooldownUntil: credit.cooldown_until });
    }
    notifyUser(credit.buyer_id, {
        type: "credit_decision", title: "Credit limit updated",
        body: "Your seller has updated your monthly credit limit.",
        link: creditLink("approved", credit.id),
    });
}

export async function declineCreditIncrease(req, res) {
    const days = Number(req.body?.cooldownDays);
    const cooldownDays = Number.isFinite(days) && days > 0 ? days : 14;

    const { data: credit } = await supabase.from("buyer_seller_credit").select("*").eq("id", req.params.id).maybeSingle();
    if (!credit || !credit.limit_increase_request_message_id) {
        return res.status(400).json({ success: false, message: "No pending limit increase request." });
    }

    const { data: sellerProfile } = await supabase.from("seller_profiles").select("user_id").eq("id", credit.seller_id).maybeSingle();
    if (!sellerProfile || sellerProfile.user_id !== req.user.id) {
        return res.status(403).json({ success: false, message: "Not authorized." });
    }

    const cooldownUntil = new Date();
    cooldownUntil.setDate(cooldownUntil.getDate() + cooldownDays);
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

    const { data: updated } = await supabase.from("buyer_seller_credit").select("*").eq("id", req.params.id).maybeSingle();

    await trackCreditEvent({
        creditId: credit.id, buyerId: credit.buyer_id, sellerId: credit.seller_id, sellerUserId: req.user.id,
        actorId: req.user.id, actorRole: "seller", eventType: "limit_increase_declined",
    });

    res.json({ success: true, credit: updated });

    if (updated?.conversation_id) {
        emitToConversation(updated.conversation_id, "message:updated", { conversationId: updated.conversation_id, messageId: requestMessageId, metadataPatch });
        emitToConversation(updated.conversation_id, "credit:decided", {
            creditId: updated.id, status: updated.status,
            limitIncreaseCooldownUntil: updated.limit_increase_cooldown_until,
        });
    }
    notifyUser(credit.buyer_id, {
        type: "credit_decision", title: "Credit limit request declined",
        body: "Your seller declined your request for a higher credit limit.",
        link: creditLink("approved", credit.id),
    });
}