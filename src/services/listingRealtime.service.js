import { getIO } from "../socket/io.js";
import { supabase } from "../config/supabase.js";
import { resolveEffectiveBasePrice } from "../../shared/customPricing.js";

export const CATALOG_ROOM = "catalog:prices";
// MUST match the room name notifyUser() emits to — adjust if yours differs.
export const userRoom = (id) => `user:${id}`;

const COLS = `id, seller_id, generic_product_brand_id, price, moq, unit, pack_size,
  units_per_master_pack, gst_percent, price_basis, marketing_commission_percent,
  freight_included, quantity_discounts, price_slabs, stock_type, stock_quantity,
  production_lead_time_days, dispatch_time_days, visibility_mode, is_active, review_status`;

// Keys are the SAME snake_case names catalog_brand_item_sellers returns,
// so the client can merge the patch straight onto a row.
function defaultPatch(s) {
    return {
        price: Number(s.price), moq: s.moq, unit: s.unit,
        pack_size: s.pack_size, units_per_master_pack: s.units_per_master_pack,
        gst_percent: s.gst_percent, price_basis: s.price_basis,
        marketing_commission_percent: s.marketing_commission_percent,
        freight_included: s.freight_included,
        quantity_discounts: s.quantity_discounts || [], price_slabs: s.price_slabs || [],
        stock_type: s.stock_type, stock_quantity: s.stock_quantity,
        production_lead_time_days: s.production_lead_time_days,
        dispatch_time_days: s.dispatch_time_days,
        is_custom_priced: false,
    };
}
// ASSUMPTION: a custom price is flat (no slabs/discounts). Change here if
// your RPC keeps discounts on custom-priced rows.
function customPatch(s, effectivePrice) {
    return { ...defaultPatch(s), price: Number(effectivePrice), quantity_discounts: [], price_slabs: [], is_custom_priced: true };
}

/**
 * Re-reads the listing from the DB (so the payload is always the truth)
 * and pushes it to whoever is allowed to see it.
 * opts.buyerIds → only these buyers (used by custom-pricing changes).
 * Never throws: realtime must not be able to fail a save.
 */
export async function publishListingChange(submissionId, { buyerIds = null } = {}) {
    try {
        const io = getIO();
        const { data: sub } = await supabase.from("seller_product_submissions")
            .select(COLS).eq("id", submissionId).maybeSingle();
        if (!sub) return;

        let ovQuery = supabase.from("buyer_seller_custom_prices")
            .select("buyer_id, override_type, discount_percent, fixed_price")
            .eq("submission_id", submissionId);
        if (buyerIds?.length) ovQuery = ovQuery.in("buyer_id", buyerIds);
        const { data: overrides } = await ovQuery;
        const ovByBuyer = new Map((overrides || []).map((o) => [o.buyer_id, o]));

        const base = {
            brandItemId: sub.generic_product_brand_id,
            submissionId: sub.id,
            sellerId: sub.seller_id,
            available: sub.is_active === true && sub.review_status === "approved",
            ts: Date.now(),
        };
        const defPrice = Number(sub.price);
        const forBuyer = (buyerId) => {
            const o = ovByBuyer.get(buyerId);
            return { ...base, patch: o ? customPatch(sub, resolveEffectiveBasePrice(defPrice, o)) : defaultPatch(sub) };
        };

        if (buyerIds?.length) {
            buyerIds.forEach((id) => io.to(userRoom(id)).emit("listing:update", forBuyer(id)));
            return;
        }

        if (sub.visibility_mode === "restricted") {
            const { data: vis } = await supabase.from("seller_listing_visibility")
                .select("buyer_id").eq("submission_id", submissionId);
            (vis || []).forEach((v) => io.to(userRoom(v.buyer_id)).emit("listing:update", forBuyer(v.buyer_id)));
            io.to(userRoom(sub.seller_id)).emit("listing:update", { ...base, patch: defaultPatch(sub) });
            return;
        }

        // Public: one broadcast, minus buyers who have their own custom price.
        const overrideIds = [...ovByBuyer.keys()];
        let op = io.to(CATALOG_ROOM);
        if (overrideIds.length) op = op.except(overrideIds.map(userRoom));
        op.emit("listing:update", { ...base, patch: defaultPatch(sub) });
        overrideIds.forEach((id) => io.to(userRoom(id)).emit("listing:update", forBuyer(id)));
    } catch (err) {
        console.error("[realtime] publishListingChange failed:", err.message);
    }
}

export function publishListingRemoved({ submissionId, brandItemId, sellerId }) {
    try {
        getIO().to(CATALOG_ROOM).emit("listing:update", {
            brandItemId, submissionId, sellerId, available: false, patch: {}, ts: Date.now(),
        });
    } catch { /* best-effort */ }
}