// shared/rfqQuoteMath.js — single source of truth for quote maths (server + client).
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e4) / 1e4;
export const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;

export const VALIDITY_OPTIONS = [
    { key: "3d", label: "3 days", days: 3 },
    { key: "7d", label: "7 days", days: 7 },
    { key: "15d", label: "15 days", days: 15 },
    { key: "30d", label: "1 month", days: 30 },
    { key: "180d", label: "6 months", days: 180 },
    { key: "365d", label: "1 year", days: 365 },
    { key: "lifetime", label: "Lifetime", days: null },
];
export const validityMeta = (key) => VALIDITY_OPTIONS.find((o) => o.key === key) || null;
export const validUntilFor = (key, now = Date.now()) => {
    const m = validityMeta(key);
    return !m || m.days == null ? null : new Date(now + m.days * 864e5).toISOString();
};

const pos = (n) => (Number(n) > 0 ? Number(n) : 1);

// How many base units (Kg, Pieces...) one "basis" unit contains.
export function basisDivisor(basis, packSize, masterPackSize) {
    if (basis === "per_pack") return pos(packSize);
    if (basis === "per_master_pack") return pos(packSize) * pos(masterPackSize);
    return 1;
}
// One listing SALE unit (Pack, or Master Pack when there is one) in base units.
export const saleDivisor = (packSize, masterPackSize) => pos(packSize) * pos(masterPackSize);

// Listing MOQ is in SALE units -> base units.
export const moqInUnits = (moq, packSize, masterPackSize) =>
    Number(moq) > 0 ? Number(moq) * saleDivisor(packSize, masterPackSize) : 0;

export const nearPrice = (a, b, tol = 0.02) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;

// Same chain the order flow uses: total is GST-inclusive, taxable = total / (1 + gst), gst = total - taxable.
export function breakdownFromUnitIncl(unitIncl, gstPercent, totalUnits) {
    const g = Number(gstPercent) || 0;
    const total = round2(Number(unitIncl) * Number(totalUnits));
    const taxable = g > 0 ? round2(total / (1 + g / 100)) : total;
    return {
        unitIncl: round6(unitIncl),
        unitExcl: round4(Number(unitIncl) / (1 + g / 100)),
        taxable, gstAmount: round2(total - taxable), total, gstPercent: g,
    };
}

// What the seller typed -> everything else.
export function computeQuoteBreakdown({ price, basis, gstInclusive, gstPercent, packSize, masterPackSize, totalUnits }) {
    const entered = Number(price);
    if (!(entered > 0)) return null;
    const g = Number(gstPercent) || 0;
    const div = basisDivisor(basis, packSize, masterPackSize);
    const inclPerBasis = gstInclusive ? entered : entered * (1 + g / 100);
    const unitIncl = round6(inclPerBasis / div);
    return { ...breakdownFromUnitIncl(unitIncl, g, totalUnits), entered, divisor: div };
}