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
        .select("default_commission_percent")
        .eq("id", 1)
        .maybeSingle();
    cachedCommissionPercent = Number(data?.default_commission_percent ?? 5);
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