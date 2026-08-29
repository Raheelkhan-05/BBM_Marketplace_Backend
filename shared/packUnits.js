// shared/packUnits.js — the single source of truth for this whole system.
// Duplicate identically on frontend and backend until you have a shared
// package; do not let the two copies drift.

export function hasOuterPack(masterPackSize) {
    return Number(masterPackSize) >= 2;
}
export function getSaleUnit(masterPackSize) {
    return hasOuterPack(masterPackSize) ? "master_pack" : "pack";
}
export function saleUnitLabel(masterPackSize) {
    return hasOuterPack(masterPackSize) ? "Master Pack" : "Pack";
}
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// How many base units (Pieces/Kg/Litres...) make up ONE sale unit.
export function saleUnitSizeInBaseUnits(packSize, masterPackSize) {
    const pack = Number(packSize) > 0 ? Number(packSize) : 1;
    const master = Number(masterPackSize) > 0 ? Number(masterPackSize) : 1;
    return hasOuterPack(masterPackSize) ? pack * master : pack;
}

// ---- Anything -> canonical sale-unit quantity ----
export function baseUnitsToSaleUnitQty(baseUnits, packSize, masterPackSize) {
    return Number(baseUnits) / saleUnitSizeInBaseUnits(packSize, masterPackSize);
}
export function saleUnitQtyToBaseUnits(saleUnitQty, packSize, masterPackSize) {
    return Number(saleUnitQty) * saleUnitSizeInBaseUnits(packSize, masterPackSize);
}
export function saleUnitQtyToPacks(saleUnitQty, masterPackSize) {
    const master = Number(masterPackSize) > 0 ? Number(masterPackSize) : 1;
    return hasOuterPack(masterPackSize) ? Number(saleUnitQty) * master : Number(saleUnitQty);
}
// A buyer's purchase quantity can be entered in ANY basis (unit/pack/
// master pack) regardless of what the seller's canonical sale unit is —
// this is the one function that reconciles the two, by routing through
// base units.
export function purchaseQtyToSaleUnitQty(qty, purchaseBasis, packSize, masterPackSize) {
    const pack = Number(packSize) > 0 ? Number(packSize) : 1;
    const master = Number(masterPackSize) > 0 ? Number(masterPackSize) : 1;
    const baseUnits =
        purchaseBasis === "per_unit" ? Number(qty) :
            purchaseBasis === "per_pack" ? Number(qty) * pack :
                Number(qty) * pack * master; // per_master_pack
    return baseUnitsToSaleUnitQty(baseUnits, packSize, masterPackSize);
}

// ---- Price ----
// priceBasis ("per_unit"/"per_pack"/"per_master_pack") is now ONLY ever a
// transient UI concept — which of the 3 price fields the seller is
// currently typing into. It is NEVER persisted; only the resulting
// per-sale-unit number is.
export function priceToSaleUnitPrice(price, priceBasis, packSize, masterPackSize) {
    const p = Number(price) || 0;
    const pack = Number(packSize) > 0 ? Number(packSize) : 1;
    const master = Number(masterPackSize) > 0 ? Number(masterPackSize) : 1;
    let perBaseUnit = p;
    if (priceBasis === "per_pack") perBaseUnit = p / pack;
    if (priceBasis === "per_master_pack") perBaseUnit = p / (pack * master);
    return perBaseUnit * saleUnitSizeInBaseUnits(packSize, masterPackSize);
}

// Derives all three DISPLAY tiers from the one canonical price. Always
// mutually consistent by construction — nothing to re-derive separately.
export function deriveDisplayPrices(pricePerSaleUnit, packSize, masterPackSize) {
    const price = Number(pricePerSaleUnit) || 0;
    const pack = Number(packSize) > 0 ? Number(packSize) : 1;
    const master = Number(masterPackSize) > 0 ? Number(masterPackSize) : 1;
    const outer = hasOuterPack(masterPackSize);
    const perBaseUnit = price / saleUnitSizeInBaseUnits(packSize, masterPackSize);
    const perPack = outer ? perBaseUnit * pack : price;
    const perMasterPack = outer ? price : perBaseUnit * pack * master;
    return { perBaseUnit, perPack, perMasterPack };
}