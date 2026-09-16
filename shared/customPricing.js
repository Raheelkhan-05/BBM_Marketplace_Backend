// shared/customPricing.js
import { round2, deriveDisplayPrices, hasOuterPack, getSaleUnit } from "./packUnits.js";


// Applies overrides to an array of rows that each carry their own
// `price` + `submission_id` (e.g. catalog_brand_item_sellers rows, cart
// rows). Clears price_slabs/quantity_discounts on overridden rows — a
// negotiated rate replaces general tiered pricing entirely.
export async function applyCustomPricingToRows(supabaseAdmin, buyerId, rows, { submissionIdKey = "submission_id", priceKey = "price" } = {}) {
    if (!buyerId || !Array.isArray(rows) || !rows.length) return rows;
    const ids = rows.map((r) => r[submissionIdKey]).filter(Boolean);
    const map = await fetchCustomPriceMap(supabaseAdmin, buyerId, ids);
    if (!map.size) return rows;
    return rows.map((r) => {
        const override = map.get(r[submissionIdKey]);
        if (!override) return r;
        return {
            ...r,
            [priceKey]: resolveEffectiveBasePrice(r[priceKey], override),
            price_slabs: [],
            quantity_discounts: [],
            is_custom_priced: true,
        };
    });
}

// Expands a per-sale-unit price into unit/pack/master-pack prices. Every
// value returned here is rounded to 2dp for DISPLAY — this is purely a
// presentation fix; the canonical per-sale-unit price stored in the DB
// is rounded separately (see priceFromLevel / resolveEffectiveBasePrice)
// and is what's actually charged, so this never introduces a mismatch
// between what's shown and what's billed — it just stops a repeating
// decimal like 500.0016666666667 from ever reaching the screen.
export function derivePriceBreakdown(pricePerSaleUnit, packSize, masterPackSize) {
    const { perBaseUnit, perPack, perMasterPack } = deriveDisplayPrices(Number(pricePerSaleUnit) || 0, packSize, masterPackSize);
    return {
        perBaseUnit: perBaseUnit != null ? round2(perBaseUnit) : null,
        perPack: perPack != null ? round2(perPack) : null,
        perMasterPack: hasOuterPack(masterPackSize) && perMasterPack != null ? round2(perMasterPack) : null,
        saleBasis: getSaleUnit(masterPackSize),
    };
}

export function priceFromLevel(enteredPrice, level, packSize, masterPackSize) {
    const pack = Number(packSize) > 0 ? Number(packSize) : 1;
    const master = Number(masterPackSize) > 0 ? Number(masterPackSize) : 1;
    const outer = hasOuterPack(masterPackSize);
    const p = Number(enteredPrice) || 0;
    if (level === "unit") return outer ? round2(p * pack * master) : round2(p * pack);
    if (level === "pack") return outer ? round2(p * master) : round2(p);
    if (level === "master_pack") return round2(p);
    return round2(p);
}

export function percentFromCustomPrice(currentBasePrice, typedCustomPrice) {
    const base = Number(currentBasePrice) || 0;
    const custom = Number(typedCustomPrice) || 0;
    if (!(base > 0)) return 0;
    // Positive = discount, negative = markup (custom > base). Answers
    // "can a seller sell above default price to this buyer" — yes.
    return Math.round(((base - custom) / base) * 100 * 1000) / 1000;
}

export function resolveEffectiveBasePrice(defaultPricePerSaleUnit, override) {
    const base = Number(defaultPricePerSaleUnit) || 0;
    if (!override) return base;
    if (override.override_type === "fixed") return round2(Number(override.fixed_price) || 0);
    const pct = Number(override.discount_percent) || 0;
    return round2(base * (1 - pct / 100));
}

export async function fetchCustomPriceMap(supabaseAdmin, buyerId, submissionIds) {
    const ids = [...new Set((submissionIds || []).filter(Boolean))];
    if (!buyerId || !ids.length) return new Map();
    const { data, error } = await supabaseAdmin
        .from("buyer_seller_custom_prices")
        .select("submission_id, override_type, discount_percent, fixed_price, base_price_at_set")
        .eq("buyer_id", buyerId)
        .in("submission_id", ids);
    if (error || !data) return new Map();
    return new Map(data.map((r) => [r.submission_id, r]));
}

// shared/customPricing.js — add this alongside the existing exports
export const MIN_UNIT_PRICE = 1; // ₹1 floor, checked at the individual-unit level

// Returns the per-base-unit price a canonical (per-sale-unit) price would
// resolve to — the same number derivePriceBreakdown already computes,
// exposed standalone so callers that only need the floor check don't have
// to destructure the full breakdown every time.
export function unitPriceFor(canonicalPrice, packSize, masterPackSize) {
    return derivePriceBreakdown(canonicalPrice, packSize, masterPackSize).perBaseUnit;
}

// The single source of truth for "is this price allowed" — used by both
// the frontend (to block the Review/Confirm buttons and show an inline
// error) and the backend (to hard-reject a save, since the frontend check
// alone can't be trusted — a stale tab, a direct API call, or a future
// bug could all bypass it otherwise).
export function violatesMinUnitPrice(canonicalPrice, packSize, masterPackSize) {
    const perUnit = unitPriceFor(canonicalPrice, packSize, masterPackSize);
    return perUnit == null || perUnit < MIN_UNIT_PRICE;
}