import { supabase } from "../config/supabase.js";

// Adds `repriced` to every awaiting-payment standard order. Never throws:
// a failed preview must not break the orders list.
export async function attachRepricePreview(buyerId, orders) {
    try {
        const list = Array.isArray(orders) ? orders : [];
        const ids = list.filter((o) => o.status === "awaiting_payment" && o.order_type === "standard").map((o) => o.id);
        if (!buyerId || !ids.length) return list;

        const { data, error } = await supabase.rpc("order_reprice_preview", { p_buyer_id: buyerId, p_order_ids: ids });
        if (error || !Array.isArray(data)) {
            console.error("[orders] reprice preview failed:", error?.message);
            return list;
        }
        const byId = new Map(data.map((r) => [r.order_id, r]));
        return list.map((o) => {
            const r = byId.get(o.id);
            return r ? {
                ...o, repriced: {
                    current_total: Number(r.current_total),
                    blocked_code: r.blocked_code || null,
                    blocked_product: r.blocked_product || null,
                    items: r.items || [],
                }
            } : o;
        });
    } catch (e) {
        console.error("[orders] reprice preview threw:", e?.message || e);
        return Array.isArray(orders) ? orders : [];
    }
}