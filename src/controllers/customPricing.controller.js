// controllers/customPricing.controller.js
import { supabase } from "../config/supabase.js";
import { percentFromCustomPrice, resolveEffectiveBasePrice, derivePriceBreakdown, violatesMinUnitPrice, MIN_UNIT_PRICE } from "../../shared/customPricing.js";
import { hasOuterPack } from "../../shared/packUnits.js";
import { publishListingChange, publishListingRemoved } from "../services/listingRealtime.service.js";
import { CATALOG_REMOVED_REJECTION_REASON } from "./sellerCatalogListings.controller.js";


export async function listCustomPricingForBuyer(req, res) {
    const sellerId = req.sellerId;
    const { buyerId } = req.params;

    const [{ data: submissions, error: subErr }, { data: overrides, error: ovErr }] = await Promise.all([
        supabase
            .from("seller_product_submissions")
            .select(`
            id, product_name, brand_name, image, price, unit, price_basis, review_status, is_active,
            pack_size, units_per_master_pack, rejection_reason, gst_percent,
            hs_generic_product_brands!inner ( deleted_at )
        `)
            .eq("seller_id", sellerId)
            .eq("review_status", "approved")
            .is("hs_generic_product_brands.deleted_at", null)
            .or(`rejection_reason.is.null,rejection_reason.neq.${CATALOG_REMOVED_REJECTION_REASON}`)
            .order("product_name", { ascending: true }),
        supabase
            .from("buyer_seller_custom_prices")
            .select("submission_id, override_type, discount_percent, fixed_price, base_price_at_set, updated_at")
            .eq("seller_id", sellerId)
            .eq("buyer_id", buyerId),
    ]);
    if (subErr) return res.status(500).json({ success: false, message: subErr.message });
    if (ovErr) return res.status(500).json({ success: false, message: ovErr.message });

    const overrideBySubmission = Object.fromEntries((overrides || []).map((o) => [o.submission_id, o]));

    const items = (submissions || []).map((s) => {
        const override = overrideBySubmission[s.id] || null;
        const defaultPrice = Number(s.price);
        const effectivePrice = override
            ? resolveEffectiveBasePrice(defaultPrice, { override_type: override.override_type, discount_percent: override.discount_percent, fixed_price: override.fixed_price })
            : defaultPrice;

        return {
            submissionId: s.id,
            name: s.product_name,
            brandName: s.brand_name,
            image: s.image,
            unit: s.unit,
            packSize: Number(s.pack_size) || 1,
            masterPackSize: Number(s.units_per_master_pack) || 1,
            hasMasterPack: hasOuterPack(s.units_per_master_pack),
            isActive: s.is_active,
            gstPercent: Number(s.gst_percent) || 0,
            defaultPrice,
            effectivePrice,
            // NEW — full unit/pack/master-pack breakdown for BOTH the
            // default and the currently-effective price, so the frontend
            // never has to re-derive this itself and can render it directly.
            defaultBreakdown: derivePriceBreakdown(defaultPrice, s.pack_size, s.units_per_master_pack),
            effectiveBreakdown: derivePriceBreakdown(effectivePrice, s.pack_size, s.units_per_master_pack),
            override: override
                ? {
                    overrideType: override.override_type,
                    discountPercent: override.discount_percent,
                    fixedPrice: override.fixed_price,
                    basePriceAtSet: override.base_price_at_set,
                    updatedAt: override.updated_at,
                }
                : null,
        };
    });

    res.json({ success: true, items, customPricedCount: items.filter((i) => i.override).length });
}

// GET /api/seller/custom-pricing/by-submission/:submissionId
// Product-centric counterpart to listCustomPricingForBuyer — for ONE
// listing, every buyer who has a custom price on it. Buyer identity
// (name/logo) is intentionally NOT joined here; the frontend resolves it
// from the seller's own chat conversation list, since custom pricing only
// ever makes sense for a buyer the seller is already talking to.
export async function listCustomPricingForSubmission(req, res) {
    const sellerId = req.sellerId;
    const { submissionId } = req.params;

    const { data: submission, error: subErr } = await supabase
        .from("seller_product_submissions")
        .select(`
            id, product_name, brand_name, image, price, unit,
            pack_size, units_per_master_pack, gst_percent,
            hs_generic_product_brands!inner ( deleted_at )
        `)
        .eq("id", submissionId)
        .eq("seller_id", sellerId)
        .is("hs_generic_product_brands.deleted_at", null)
        .maybeSingle();
    if (subErr) return res.status(500).json({ success: false, message: subErr.message });
    if (!submission) return res.status(404).json({ success: false, message: "Listing not found." });

    const { data: overrides, error: ovErr } = await supabase
        .from("buyer_seller_custom_prices")
        .select("buyer_id, override_type, discount_percent, fixed_price, base_price_at_set, updated_at")
        .eq("seller_id", sellerId)
        .eq("submission_id", submissionId)
        .order("updated_at", { ascending: false });
    if (ovErr) return res.status(500).json({ success: false, message: ovErr.message });

    const defaultPrice = Number(submission.price);
    const product = {
        submissionId: submission.id,
        name: submission.product_name,
        brandName: submission.brand_name,
        image: submission.image,
        unit: submission.unit,
        packSize: Number(submission.pack_size) || 1,
        masterPackSize: Number(submission.units_per_master_pack) || 1,
        hasMasterPack: hasOuterPack(submission.units_per_master_pack),
        gstPercent: Number(submission.gst_percent) || 0,
        defaultPrice,
        defaultBreakdown: derivePriceBreakdown(defaultPrice, submission.pack_size, submission.units_per_master_pack),
    };

    const buyers = (overrides || []).map((o) => {
        const effectivePrice = resolveEffectiveBasePrice(defaultPrice, o);
        return {
            buyerId: o.buyer_id,
            overrideType: o.override_type,
            discountPercent: o.discount_percent,
            fixedPrice: o.fixed_price,
            basePriceAtSet: o.base_price_at_set,
            updatedAt: o.updated_at,
            effectivePrice,
            effectiveBreakdown: derivePriceBreakdown(effectivePrice, submission.pack_size, submission.units_per_master_pack),
        };
    });

    res.json({ success: true, product, buyers });
}

// POST /api/seller/custom-pricing/:buyerId
// body: { items: [{ submissionId, overrideType: 'percent'|'fixed', value }] }
// `value` is either a discount percent (0-100, can be negative for a
// markup) or an absolute price, per overrideType. Percent stored as-is;
// for fixed we also back-compute+store an equivalent percent isn't
// needed since fixed bypasses percent entirely at read time.
// For convenience the frontend can ALSO send `typedPrice` instead of a
// raw percent — see toDiscountPercent below — so the seller can just
// type "₹450" and get percent-mode storage (the relation-preserving
// path) without doing math themselves.
export async function upsertCustomPricing(req, res) {
    const sellerId = req.sellerId;
    const { buyerId } = req.params;
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ success: false, message: "No items provided." });
    }

    const submissionIds = items.map((i) => i.submissionId).filter(Boolean);
    const { data: submissions, error: subErr } = await supabase
        .from("seller_product_submissions")
        .select(`id, price, review_status, rejection_reason, hs_generic_product_brands!inner ( deleted_at )`)
        .eq("seller_id", sellerId)
        .eq("review_status", "approved")
        .is("hs_generic_product_brands.deleted_at", null)
        .or(`rejection_reason.is.null,rejection_reason.neq.${CATALOG_REMOVED_REJECTION_REASON}`)
        .in("id", submissionIds);
    if (subErr) return res.status(500).json({ success: false, message: subErr.message });
    const submissionById = Object.fromEntries((submissions || []).map((s) => [s.id, s]));

    const MAX_ABS_PERCENT = 99999999;               // discount_percent is numeric(14,3)
    const clampPercent = (p) => Math.max(-MAX_ABS_PERCENT, Math.min(MAX_ABS_PERCENT, Math.round(p * 1000) / 1000));
    const MAX_PRICE = 9999999999.99;                // fixed_price is numeric(12,2)

    const rows = [];
    const skipped = [];

    for (const item of items) {
        const submission = submissionById[item.submissionId];
        if (!submission) { skipped.push({ submissionId: item.submissionId, reason: "not_found_or_not_eligible" }); continue; }
        const basePrice = Number(submission.price);

        let canonicalPrice;
        let percentForStore;
        if (item.overrideType === "fixed") {
            canonicalPrice = Number(item.value);
            percentForStore = percentFromCustomPrice(basePrice, canonicalPrice);
        } else {
            const pct = item.inputMode === "typed_price"
                ? percentFromCustomPrice(basePrice, Number(item.value))
                : Number(item.value);
            if (!Number.isFinite(pct)) { skipped.push({ submissionId: item.submissionId, reason: "invalid_percent" }); continue; }
            canonicalPrice = Math.round(basePrice * (1 - pct / 100) * 100) / 100;
            percentForStore = pct;
        }

        if (!Number.isFinite(canonicalPrice) || canonicalPrice <= 0) {
            return res.status(400).json({ success: false, message: "The resulting price must be greater than ₹0." });
        }
        if (canonicalPrice > MAX_PRICE) {
            return res.status(400).json({ success: false, message: "That price is too large to store." });
        }

        // Markups (negative percent) and explicit prices are stored as fixed prices;
        // only true discounts are stored as percent overrides.
        const asFixed = item.overrideType === "fixed" || percentForStore < 0;
        rows.push({
            seller_id: sellerId, buyer_id: buyerId, submission_id: item.submissionId,
            override_type: asFixed ? "fixed" : "percent",
            discount_percent: asFixed ? clampPercent(percentForStore) : clampPercent(percentForStore),
            fixed_price: asFixed ? canonicalPrice : null,
            base_price_at_set: basePrice,
        });
    }

    if (!rows.length) {
        return res.status(400).json({ success: false, message: "Nothing valid to save.", skipped });
    }

    const { error } = await supabase
        .from("buyer_seller_custom_prices")
        .upsert(rows, { onConflict: "seller_id,buyer_id,submission_id" });
    if (error) {
        console.error("[custom-pricing] upsert failed", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }

    rows.forEach((r) => void publishListingChange(r.submission_id, { buyerIds: [buyerId] }));
    res.json({ success: true, saved: rows.length, rejected: [] });
}

// DELETE /api/seller/custom-pricing/:buyerId/:submissionId
export async function deleteCustomPricing(req, res) {
    const sellerId = req.sellerId;
    const { buyerId, submissionId } = req.params;
    const { error } = await supabase
        .from("buyer_seller_custom_prices")
        .delete()
        .eq("seller_id", sellerId).eq("buyer_id", buyerId).eq("submission_id", submissionId);
    if (error) return res.status(500).json({ success: false, message: error.message });
    void publishListingChange(submissionId, { buyerIds: [buyerId] });
    res.json({ success: true });
}

// POST /api/seller/custom-pricing/:buyerId/bulk-clear
// body: { submissionIds?: string[] } — omit to clear ALL for this buyer.
export async function bulkClearCustomPricing(req, res) {
    const sellerId = req.sellerId;
    const { buyerId } = req.params;
    const { submissionIds } = req.body || {};

    let ids = submissionIds;
    if (!Array.isArray(ids) || !ids.length) {
        const { data } = await supabase.from("buyer_seller_custom_prices")
            .select("submission_id").eq("seller_id", sellerId).eq("buyer_id", buyerId);
        ids = (data || []).map((r) => r.submission_id);
    }

    let query = supabase.from("buyer_seller_custom_prices").delete().eq("seller_id", sellerId).eq("buyer_id", buyerId);
    if (Array.isArray(submissionIds) && submissionIds.length) query = query.in("submission_id", submissionIds);

    const { error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    ids.forEach((sid) => void publishListingChange(sid, { buyerIds: [buyerId] }));

    res.json({ success: true });
}