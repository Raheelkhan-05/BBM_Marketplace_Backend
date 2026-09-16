// controllers/customPricing.controller.js
import { supabase } from "../config/supabase.js";
import { percentFromCustomPrice, resolveEffectiveBasePrice, derivePriceBreakdown, violatesMinUnitPrice, MIN_UNIT_PRICE } from "../../shared/customPricing.js";
import { hasOuterPack } from "../../shared/packUnits.js";
import { CATALOG_REMOVED_REJECTION_REASON } from "./sellerCatalogListings.controller.js";


export async function listCustomPricingForBuyer(req, res) {
    const sellerId = req.sellerId;
    const { buyerId } = req.params;

    const [{ data: submissions, error: subErr }, { data: overrides, error: ovErr }] = await Promise.all([
        supabase
            .from("seller_product_submissions")
            .select(`
                id, product_name, brand_name, image, price, unit, price_basis, review_status, is_active,
                pack_size, units_per_master_pack, rejection_reason,
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
// controllers/customPricing.controller.js

export async function upsertCustomPricing(req, res) {
    const sellerId = req.sellerId;
    const { buyerId } = req.params;
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ success: false, message: "No items provided." });
    }

    const submissionIds = items.map((i) => i.submissionId).filter(Boolean);
    // NEW: pack_size / units_per_master_pack are now selected too — the
    // floor check needs them to know what "per unit" actually means for
    // each listing (a master-pack listing's per-unit price is a much
    // smaller slice of the entered number than a plain-pack listing's).
    const { data: submissions, error: subErr } = await supabase
        .from("seller_product_submissions")
        .select(`id, price, pack_size, units_per_master_pack, review_status, rejection_reason, hs_generic_product_brands!inner ( deleted_at )`)
        .eq("seller_id", sellerId)
        .eq("review_status", "approved")
        .is("hs_generic_product_brands.deleted_at", null)
        .or(`rejection_reason.is.null,rejection_reason.neq.${CATALOG_REMOVED_REJECTION_REASON}`)
        .in("id", submissionIds);
    if (subErr) return res.status(500).json({ success: false, message: subErr.message });
    const submissionById = Object.fromEntries((submissions || []).map((s) => [s.id, s]));

    const rows = [];
    const rejected = []; // NEW — collected so the seller learns exactly which products failed and why, instead of a silent partial save

    for (const item of items) {
        const submission = submissionById[item.submissionId];
        if (!submission) continue; // not this seller's listing, or no longer eligible — skip silently as before
        const basePrice = Number(submission.price);

        let canonicalPrice;
        if (item.overrideType === "fixed") {
            canonicalPrice = Number(item.value);
            if (!(canonicalPrice >= 0)) continue;
        } else {
            const discountPercent = item.inputMode === "typed_price"
                ? percentFromCustomPrice(basePrice, Number(item.value))
                : Number(item.value);
            if (!Number.isFinite(discountPercent)) continue;
            canonicalPrice = Math.round(basePrice * (1 - discountPercent / 100) * 100) / 100;
        }

        // NEW — the actual guard. Checked in rupees per PIECE/KG/whatever
        // the listing's base unit is, not per pack or master pack, since
        // that's the level a mistaken 400%-off bulk edit would first go
        // negative or near-zero at even while the pack/master-pack number
        // still looks like a "real" price.
        if (violatesMinUnitPrice(canonicalPrice, submission.pack_size, submission.units_per_master_pack)) {
            const perUnit = derivePriceBreakdown(canonicalPrice, submission.pack_size, submission.units_per_master_pack).perBaseUnit;
            rejected.push({ submissionId: item.submissionId, perUnitPrice: perUnit });
            continue;
        }

        if (item.overrideType === "fixed") {
            rows.push({
                seller_id: sellerId, buyer_id: buyerId, submission_id: item.submissionId,
                override_type: "fixed",
                // Stored for reference/future recompute ONLY — never used to
                // reconstruct the charged price. The charged price is always
                // fixed_price, exactly as entered.
                discount_percent: percentFromCustomPrice(basePrice, canonicalPrice),
                fixed_price: canonicalPrice,
                base_price_at_set: basePrice,
            });
        } else {
            const discountPercent = item.inputMode === "typed_price"
                ? percentFromCustomPrice(basePrice, Number(item.value))
                : Number(item.value);
            rows.push({
                seller_id: sellerId, buyer_id: buyerId, submission_id: item.submissionId,
                override_type: "percent", discount_percent: discountPercent, fixed_price: null,
                base_price_at_set: basePrice,
            });
        }
    }

    // NEW — if EVERY requested item failed the floor check, there's
    // nothing to save at all; say so clearly rather than returning a
    // generic "Nothing valid to save."
    if (!rows.length) {
        if (rejected.length) {
            return res.status(400).json({
                success: false,
                code: "BELOW_MIN_UNIT_PRICE",
                message: `That price works out to below ₹${MIN_UNIT_PRICE} per unit for ${rejected.length} product${rejected.length === 1 ? "" : "s"} — nothing was saved.`,
                rejected,
            });
        }
        return res.status(400).json({ success: false, message: "Nothing valid to save." });
    }

    const { error } = await supabase
        .from("buyer_seller_custom_prices")
        .upsert(rows, { onConflict: "seller_id,buyer_id,submission_id" });
    if (error) return res.status(500).json({ success: false, message: error.message });

    // NEW — a PARTIAL success: some saved, some rejected. Still 200, but
    // the frontend needs `rejected` to tell the seller which products
    // didn't go through, since the rest of the batch did commit.
    res.json({ success: true, saved: rows.length, rejected });
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
    res.json({ success: true });
}

// POST /api/seller/custom-pricing/:buyerId/bulk-clear
// body: { submissionIds?: string[] } — omit to clear ALL for this buyer.
export async function bulkClearCustomPricing(req, res) {
    const sellerId = req.sellerId;
    const { buyerId } = req.params;
    const { submissionIds } = req.body || {};

    let query = supabase.from("buyer_seller_custom_prices").delete().eq("seller_id", sellerId).eq("buyer_id", buyerId);
    if (Array.isArray(submissionIds) && submissionIds.length) query = query.in("submission_id", submissionIds);

    const { error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true });
}