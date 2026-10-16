// controllers/sellerListingVisibility.controller.js
//
// Manages the buyer allow-list for a single listing, and returns it
// merged with that listing's existing custom-pricing overrides so the
// seller sees "who can see this, and what they pay" in one place.
//
// Eligibility rules ("not deleted, phone only if verified, email only if
// verified") are enforced ENTIRELY inside search_eligible_buyers() at the
// DB level (see migration) — this file never re-implements them, it just
// calls that function and trusts its output. addVisibilityBuyer() still
// re-checks deleted_at as defense-in-depth against someone hitting the
// endpoint directly with an arbitrary id.
import { supabase } from "../config/supabase.js";
import { resolveEffectiveBasePrice, derivePriceBreakdown } from "../../shared/customPricing.js";
import { resolveCompanyId, resolveCompanyIds } from "../services/team.service.js";
import { hasOuterPack } from "../../shared/packUnits.js";
import { publishListingChange } from "../services/listingRealtime.service.js";
import { logPriceAudience } from "../services/team.service.js";

async function loadOwnedSubmission(sellerId, submissionId, columns) {
    const { data, error } = await supabase
        .from("seller_product_submissions")
        .select(columns)
        .eq("id", submissionId)
        .eq("seller_id", sellerId)
        .maybeSingle();
    return { data, error };
}

export async function getListingAccess(req, res) {
    const sellerId = req.sellerId;
    const { id: submissionId } = req.params;

    const { data: submission, error: subErr } = await loadOwnedSubmission(
        sellerId, submissionId,
        "id, product_name, brand_name, image, price, visibility_mode, pack_size, units_per_master_pack, gst_percent, unit"
    );
    if (subErr) return res.status(500).json({ success: false, message: subErr.message });
    if (!submission) return res.status(404).json({ success: false, message: "Listing not found." });

    const [{ data: visRows, error: visErr }, { data: overrides, error: ovErr }] = await Promise.all([
        supabase.from("seller_listing_visibility").select("buyer_id, created_at").eq("submission_id", submissionId),
        supabase.from("buyer_seller_custom_prices")
            .select("buyer_id, override_type, discount_percent, fixed_price, base_price_at_set, updated_at")
            .eq("seller_id", sellerId).eq("submission_id", submissionId),
    ]);
    if (visErr) return res.status(500).json({ success: false, message: visErr.message });
    if (ovErr) return res.status(500).json({ success: false, message: ovErr.message });

    const grantedAtByBuyer = Object.fromEntries((visRows || []).map((r) => [r.buyer_id, r.created_at]));
    const overrideByBuyer = Object.fromEntries((overrides || []).map((o) => [o.buyer_id, o]));
    const buyerIds = Array.from(new Set([...Object.keys(grantedAtByBuyer), ...Object.keys(overrideByBuyer)]));

    let profilesById = {};
    if (buyerIds.length) {
        const { data: profileRows, error: profErr } = await supabase
            .from("profiles")
            .select("id, name, phone, phone_verified, email, email_verified, deleted_at, business_profiles(display_name, trade_name, legal_name)")
            .in("id", buyerIds);
        if (profErr) return res.status(500).json({ success: false, message: profErr.message });
        profilesById = Object.fromEntries((profileRows || []).map((p) => [p.id, p]));
    }

    const defaultPrice = Number(submission.price);
    const buyers = buyerIds
        .map((buyerId) => {
            const p = profilesById[buyerId];
            if (!p || p.deleted_at) return null;
            const override = overrideByBuyer[buyerId] || null;
            const effectivePrice = override ? resolveEffectiveBasePrice(defaultPrice, override) : defaultPrice;
            const bp = Array.isArray(p.business_profiles) ? p.business_profiles[0] : p.business_profiles;
            return {
                buyerId,
                name: p.name || null,
                phone: p.phone_verified ? p.phone : null,
                email: p.email_verified ? p.email : null,
                shopName: bp?.display_name || bp?.trade_name || bp?.legal_name || null,
                hasVisibilityGrant: !!grantedAtByBuyer[buyerId],
                grantedAt: grantedAtByBuyer[buyerId] || null,
                override: override ? {
                    overrideType: override.override_type,
                    discountPercent: override.discount_percent,
                    fixedPrice: override.fixed_price,
                    basePriceAtSet: override.base_price_at_set,
                    updatedAt: override.updated_at,
                } : null,
                defaultPrice,
                effectivePrice,
                effectiveBreakdown: derivePriceBreakdown(effectivePrice, submission.pack_size, submission.units_per_master_pack),
            };
        })
        .filter(Boolean)
        .sort((a, b) => (a.shopName || a.name || "").localeCompare(b.shopName || b.name || ""));

    res.json({
        success: true,
        submission: {
            id: submission.id,
            productName: submission.product_name,
            brandName: submission.brand_name,
            image: submission.image,
            visibilityMode: submission.visibility_mode,
            // NEW — these four were being selected from the DB and used to
            // compute defaultBreakdown/effectiveBreakdown, but never actually
            // put on the response object. BuyerPriceEditor needs the RAW
            // values (not just the pre-derived breakdown) to convert between
            // unit/pack/master-pack and to run GST math — without them every
            // level silently fell back to packSize=1/masterPackSize=1 inside
            // the shared pack-math helpers, which is why Unit and Pack
            // collapsed to the same number, and why GST toggling did nothing
            // (gstPercent read as 0).
            unit: submission.unit,
            packSize: Number(submission.pack_size) || 1,
            masterPackSize: Number(submission.units_per_master_pack) || 1,
            hasMasterPack: hasOuterPack(submission.units_per_master_pack),
            gstPercent: Number(submission.gst_percent) || 0,
            defaultPrice,
            defaultBreakdown: derivePriceBreakdown(defaultPrice, submission.pack_size, submission.units_per_master_pack),
        },
        buyers,
    });
}

// setVisibilityMode / addVisibilityBuyer / removeVisibilityBuyer / searchEligibleBuyersForSeller — unchanged

// PATCH /api/seller/catalog/submissions/:id/visibility-mode  { mode }
export async function setVisibilityMode(req, res) {
    const sellerId = req.sellerId;
    const { id: submissionId } = req.params;
    const { mode } = req.body || {};
    if (!["public", "restricted"].includes(mode)) {
        return res.status(400).json({ success: false, message: "mode must be 'public' or 'restricted'." });
    }

    const { data: submission, error: subErr } = await loadOwnedSubmission(sellerId, submissionId, "id");
    if (subErr) return res.status(500).json({ success: false, message: subErr.message });
    if (!submission) return res.status(404).json({ success: false, message: "Listing not found." });

    if (mode === "restricted") {
        // Backfill: a buyer who already has a custom price on this listing
        // shouldn't silently lose visibility the moment restriction turns
        // on — they're clearly someone this seller already deals with.
        const { data: overrides } = await supabase
            .from("buyer_seller_custom_prices")
            .select("buyer_id")
            .eq("seller_id", sellerId).eq("submission_id", submissionId);
        const toBackfill = (overrides || []).map((o) => ({ submission_id: submissionId, seller_id: sellerId, buyer_id: o.buyer_id }));
        if (toBackfill.length) {
            await supabase.from("seller_listing_visibility")
                .upsert(toBackfill, { onConflict: "submission_id,buyer_id", ignoreDuplicates: true });
        }
    }

    const { error } = await supabase
        .from("seller_product_submissions")
        .update({ visibility_mode: mode })
        .eq("id", submissionId).eq("seller_id", sellerId);
    if (error) return res.status(500).json({ success: false, message: error.message });

    void publishListingChange(submissionId);
    res.json({ success: true, visibilityMode: mode });
}

// POST /api/seller/catalog/submissions/:id/visibility/buyers  { buyerId }
export async function addVisibilityBuyer(req, res) {
    const sellerId = req.sellerId;
    const { id: submissionId } = req.params;
    const rawId = req.body?.buyerId;
    if (!rawId) return res.status(400).json({ success: false, message: "buyerId is required." });

    const buyerId = await resolveCompanyId(rawId);          // <- company, not the person
    if (String(buyerId) === String(sellerId)) {
        return res.status(400).json({ success: false, message: "You can't add yourself as a buyer." });
    }

    const { data: submission, error: subErr } = await loadOwnedSubmission(sellerId, submissionId, "id");
    if (subErr) return res.status(500).json({ success: false, message: subErr.message });
    if (!submission) return res.status(404).json({ success: false, message: "Listing not found." });

    // Defense in depth — search_eligible_buyers already filters this out,
    // but this endpoint can be hit directly with an arbitrary id.
    const { data: buyer, error: buyerErr } = await supabase
        .from("profiles").select("id, deleted_at").eq("id", buyerId).maybeSingle();
    if (buyerErr) return res.status(500).json({ success: false, message: buyerErr.message });
    if (!buyer || buyer.deleted_at) {
        return res.status(400).json({ success: false, message: "This buyer isn't available to add." });
    }

    const { error } = await supabase
        .from("seller_listing_visibility")
        .upsert(
            { submission_id: submissionId, seller_id: sellerId, buyer_id: buyerId },
            { onConflict: "submission_id,buyer_id", ignoreDuplicates: true }
        );
    if (error) return res.status(500).json({ success: false, message: error.message });

    void publishListingChange(submissionId, { buyerIds: [buyerId] });

    // void logPriceAudience(req, { action: "VISIBILITY GRANTED", buyerId, submissionIds: [submissionId] });

    res.json({ success: true });
}

// DELETE /api/seller/catalog/submissions/:id/visibility/buyers/:buyerId
export async function removeVisibilityBuyer(req, res) {
    const sellerId = req.sellerId;
    const { id: submissionId, buyerId: raw } = req.params;
    const buyerId = await resolveCompanyId(raw);
    const { error } = await supabase.from("seller_listing_visibility").delete()
        .eq("submission_id", submissionId).eq("seller_id", sellerId)
        .in("buyer_id", [...new Set([String(raw), String(buyerId)])]);
    if (error) return res.status(500).json({ success: false, message: error.message });

    void publishListingChange(submissionId, { buyerIds: [buyerId] });

    // void logPriceAudience(req, { action: "VISIBILITY REVOKED", buyerId, submissionIds: [submissionId] });
    res.json({ success: true });
}

// GET /api/seller/catalog/buyers/search?q=&submissionId=
export async function searchEligibleBuyersForSeller(req, res) {
    const sellerId = String(req.sellerId);
    const { q = "", submissionId } = req.query;
    const trimmed = String(q).trim();
    if (trimmed.length < 2) return res.json({ success: true, buyers: [] });

    let excludeIds = [];
    if (submissionId) {
        const { data: existing } = await supabase
            .from("seller_listing_visibility").select("buyer_id")
            .eq("submission_id", submissionId).eq("seller_id", sellerId);
        excludeIds = (existing || []).map((r) => String(r.buyer_id));
    }
    if (!excludeIds.includes(sellerId)) excludeIds.push(sellerId);

    // Over-fetch: several hits may collapse into one company.
    const { data, error } = await supabase.rpc("search_eligible_buyers", {
        p_query: trimmed, p_limit: 30, p_exclude_buyer_ids: excludeIds,
    });
    if (error) return res.status(500).json({ success: false, message: error.message });

    const rows = data || [];
    const companyOf = await resolveCompanyIds(rows.map((r) => r.buyer_id));
    const swapIds = [...new Set(rows.map((r) => companyOf.get(String(r.buyer_id)))
        .filter((cid, i) => cid !== String(rows[i].buyer_id)))];

    let owners = {};
    if (swapIds.length) {
        const { data: profs } = await supabase
            .from("profiles")
            .select("id, name, phone, phone_verified, email, email_verified, business_profiles(display_name, trade_name, legal_name)")
            .in("id", swapIds).is("deleted_at", null);
        owners = Object.fromEntries((profs || []).map((p) => [String(p.id), p]));
    }

    const skip = new Set(excludeIds);
    const seen = new Set();
    const out = [];
    for (const r of rows) {
        const cid = companyOf.get(String(r.buyer_id));
        if (skip.has(cid) || seen.has(cid)) continue;
        if (cid === String(r.buyer_id)) { seen.add(cid); out.push(r); continue; }
        const o = owners[cid];
        if (!o) continue;
        const bp = Array.isArray(o.business_profiles) ? o.business_profiles[0] : o.business_profiles;
        seen.add(cid);
        out.push({
            buyer_id: cid, name: o.name || null,
            phone: o.phone_verified ? o.phone : null, email: o.email_verified ? o.email : null,
            shop_name: bp?.display_name || bp?.trade_name || bp?.legal_name || null,
        });
    }
    res.json({ success: true, buyers: out.slice(0, 8) });
}