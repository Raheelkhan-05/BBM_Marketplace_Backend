// services/pricing.service.js
//
// Single source of truth for every derived commercial number on a
// seller listing — used by the submissions controller (to persist
// canonical values) and by the commission-info endpoint the frontend
// polls once per form load. Keeping this in one place means the DB
// trigger's price math, the API's payout math, and the frontend's
// live preview math can never quietly drift apart.

import { supabase } from "../config/supabase.js";

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

export function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
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

/**
 * The seller now enters ONE base price against ONE basis (per unit /
 * per pack / per master pack), and a toggle for whether that price
 * already includes GST. Everything buyer-facing (price/unit, the
 * comparison badges, order math) is normalized to "excl. GST, per
 * single unit" so every existing reader of `base_price` / `price`
 * keeps working unchanged.
 *
 * @param {number} enteredPrice - raw number the seller typed
 * @param {number} gstPercent
 * @param {boolean} gstInclusive - true if enteredPrice already includes GST
 * @param {'per_unit'|'per_pack'|'per_master_pack'} basis
 * @param {number} packSize - units per pack (>=1)
 * @param {number} unitsPerMasterPack - packs per master pack (>=1), optional
 * @returns {{ basePricePerUnit: number, finalPricePerUnit: number }}
 */
export function normalizeEnteredPrice(enteredPrice, gstPercent, gstInclusive, basis, packSize, unitsPerMasterPack) {
    const price = Number(enteredPrice) || 0;
    const gst = Number(gstPercent) || 0;
    const pack = Number(packSize) > 0 ? Number(packSize) : 1;
    const master = Number(unitsPerMasterPack) > 0 ? Number(unitsPerMasterPack) : 1;

    // 1. strip GST if the seller entered a GST-inclusive number
    const exGst = gstInclusive ? price / (1 + gst / 100) : price;

    // 2. bring it down to a single-unit basis
    let perUnitExGst = exGst;
    if (basis === "per_pack") perUnitExGst = exGst;
    if (basis === "per_master_pack") perUnitExGst = exGst / master;

    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    return {
        basePricePerUnit: round2(perUnitExGst),
        finalPricePerUnit: round2(perUnitExGst * (1 + gst / 100)),
    };
}

/**
 * Inverse of the above — given a stored per-unit base price, express it
 * back in whatever basis/inclusivity the seller last used, for
 * re-populating the edit form.
 */
export function denormalizePriceForEdit(basePricePerUnit, gstPercent, gstInclusive, basis, packSize, unitsPerMasterPack) {
    const gst = Number(gstPercent) || 0;
    const pack = Number(packSize) > 0 ? Number(packSize) : 1;
    const master = Number(unitsPerMasterPack) > 0 ? Number(unitsPerMasterPack) : 1;

    let scaled = Number(basePricePerUnit) || 0;
    if (basis === "per_pack") scaled *= pack;
    if (basis === "per_master_pack") scaled *= pack * master;

    const displayPrice = gstInclusive ? scaled * (1 + gst / 100) : scaled;
    return Math.round((displayPrice + Number.EPSILON) * 100) / 100;
}