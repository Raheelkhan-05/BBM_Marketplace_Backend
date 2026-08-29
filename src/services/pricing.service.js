// services/pricing.service.js
//
// Single source of truth for every derived commercial number on a
// seller listing — used by the submissions controller (to persist
// canonical values) and by the commission-info endpoint the frontend
// polls once per form load. Keeping this in one place means the DB
// trigger's price math, the API's payout math, and the frontend's
// live preview math can never quietly drift apart.

import { supabase } from "../config/supabase.js";
import { priceToSaleUnitPrice, deriveDisplayPrices, round2 } from "../../shared/packUnits.js";


let cachedCommissionPercent = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

export async function getCommissionPercent() {
    if (cachedCommissionPercent != null && Date.now() - cachedAt < CACHE_MS) {
        return cachedCommissionPercent;
    }
    const { data } = await supabase
        .from("platform_settings")
        .select("commission_percent")
        .eq("id", 1)
        .maybeSingle();
    cachedCommissionPercent = Number(data?.commission_percent ?? 2.5);
    cachedAt = Date.now();
    return cachedCommissionPercent;
}

export function computeFinalPrice(basePrice, gstPercent) {
    return round2(Number(basePrice) * (1 + Number(gstPercent || 0) / 100));
}

export async function computeMarketplaceFigures(finalPrice) {
    const commissionPercent = await getCommissionPercent();
    const commissionAmount = round2(Number(finalPrice) * (commissionPercent / 100));
    const sellerPayout = round2(Number(finalPrice) - commissionAmount);
    return {
        commissionPercent,
        commissionAmount,
        sellerPayout,
        bbmSellingPrice: Number(finalPrice), // marketplace doesn't mark up over the seller's listed price
    };
}

// Anchors on the SALE UNIT now (Pack, or Master Pack if the listing has
// an outer pack) instead of the base unit. This is what gets written to
// price/base_price — every downstream consumer (MOQ math, slabs,
// discounts, order quotes) shares this one denomination from here on,
// so nobody has to re-scale by packSize/masterPackSize ever again.
export function normalizeEnteredPrice(basePrice, gstPercent, gstInclusive, priceBasis, packSize, masterPackSize) {
    const gst = Number(gstPercent) || 0;
    const perSaleUnit = priceToSaleUnitPrice(basePrice, priceBasis, packSize, masterPackSize);

    let basePricePerSaleUnit, gstAmount, subtotalAfterGst;
    if (gstInclusive) {
        subtotalAfterGst = round2(perSaleUnit);
        basePricePerSaleUnit = round2(subtotalAfterGst / (1 + gst / 100));
        gstAmount = round2(subtotalAfterGst - basePricePerSaleUnit);
    } else {
        basePricePerSaleUnit = round2(perSaleUnit);
        gstAmount = round2(basePricePerSaleUnit * (gst / 100));
        subtotalAfterGst = round2(basePricePerSaleUnit + gstAmount);
    }

    // Keep your existing commission composition on subtotalAfterGst
    // exactly as before — only the anchor changed, not the GST/commission
    // math itself.
    // ... existing commission logic, applied to subtotalAfterGst ...

    return { basePricePerSaleUnit, gstAmount, subtotalAfterGst /*, finalPricePerSaleUnit */ };
}

/**
 * Inverse of normalizeEnteredPrice — given the stored per-SALE-UNIT base
 * price, express it back in whatever basis/inclusivity the seller last
 * used, for re-populating the edit form.
 */
export function denormalizePriceForEdit(basePricePerSaleUnit, gstPercent, gstInclusive, basis, packSize, unitsPerMasterPack) {
    const gst = Number(gstPercent) || 0;
    const { perBaseUnit, perPack, perMasterPack } = deriveDisplayPrices(basePricePerSaleUnit, packSize, unitsPerMasterPack);
    const scaled = basis === "per_unit" ? perBaseUnit : basis === "per_pack" ? perPack : perMasterPack;
    const displayPrice = gstInclusive ? scaled * (1 + gst / 100) : scaled;
    return Math.round((displayPrice + Number.EPSILON) * 100) / 100;
}