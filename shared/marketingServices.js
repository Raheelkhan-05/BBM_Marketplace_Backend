// shared/marketingServices.js — imported by BOTH backend and frontend.
// To add / remove / reprice a service, edit this array only.
// Keep every percent at <= 2 decimals. The `required` service is always on and locked.
// Repricing does NOT change listings that already saved a plan: they keep the
// percent they were saved with until the seller re-saves (orders are also snapshotted).

export const MARKETING_FEE_GST_PERCENT = 18; // keep equal to the 0.18 in wallet_accrue_commission

export const MARKETING_SERVICES = [
    {
        key: "product_listing", label: "Product Listing", percent: 0.25, required: true, icon: "Store",
        description: "Get your product listed and orderable on the marketplace."
    },
    {
        key: "category_visibility", label: "Generic Visibility", percent: 0.75, icon: "LayoutGrid",
        description: "Show up higher in generic search results."
    },
    {
        key: "buyer_discovery", label: "Buyer Discovery", percent: 2, icon: "Users",
        description: "Recommend your product to buyers who match it."
    },
    {
        key: "targeted_promotions", label: "Targeted Promotions", percent: 3, icon: "Target",
        description: "Promote to buyers who buy similar products."
    },
    {
        key: "distribution_network", label: "Distribution Network Promotion", percent: 7, icon: "Share2",
        description: "Promote through the BBM distributor and dealer network."
    },
    {
        key: "featured_placement", label: "Featured Placement", percent: 10, icon: "Sparkles",
        description: "Get featured spots on the home feed."
    },
    {
        key: "promo_campaigns", label: "Promotional Campaigns", percent: 6, icon: "Megaphone",
        description: "Include the product in platform-wide campaigns."
    },
];

const BY_KEY = new Map(MARKETING_SERVICES.map((s) => [s.key, s]));
export const getService = (key) => BY_KEY.get(key) || null;
export const isKnownServiceKey = (key) => BY_KEY.has(key);
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Unknown keys dropped, required keys forced on, config order, no duplicates.
export function normalizeServiceKeys(keys) {
    const set = new Set(Array.isArray(keys) ? keys : []);
    return MARKETING_SERVICES.filter((s) => s.required || set.has(s.key)).map((s) => s.key);
}
export function sumServicePercent(keys) {
    return round2(normalizeServiceKeys(keys).reduce((a, k) => a + BY_KEY.get(k).percent, 0));
}
export function buildServicePlan(keys) {
    return normalizeServiceKeys(keys).map((k) => {
        const s = BY_KEY.get(k);
        return { key: s.key, label: s.label, percent: s.percent };
    });
}
// mode: "set" (replace) | "add" | "remove". `current` may be null (legacy listing).
export function computeNextServices(current, mode, keys) {
    const cur = Array.isArray(current) ? current : [];
    const pick = new Set(Array.isArray(keys) ? keys : []);
    if (mode === "add") return normalizeServiceKeys([...cur, ...pick]);
    if (mode === "remove") return normalizeServiceKeys(cur.filter((k) => !pick.has(k)));
    return normalizeServiceKeys([...pick]);
}
export function feeExample(orderValue, percent) {
    const fee = round2((Number(orderValue) || 0) * (Number(percent) || 0) / 100);
    const gst = round2(fee * MARKETING_FEE_GST_PERCENT / 100);
    return { fee, gst, total: round2(fee + gst) };
}