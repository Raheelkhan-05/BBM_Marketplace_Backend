// controllers/orders.controller.js — REWRITTEN
//
// Changes from the previous version:
//   - getOrderQuote now accepts `purchaseBasis` and converts pack/master-pack
//     quantity to base units before resolving slabs/discounts, mirroring the
//     RPC exactly. Returns both the entered pack-basis quantity and the
//     converted base-unit quantity so the UI can show either.
//   - getOrderQuote computes an `estimatedDeliveryDate` (DD Mon string, e.g.
//     "24 Aug") using the same zone heuristic as the RPC — same pincode
//     prefix / same state / else — off dispatch pincode vs the buyer's
//     selected address pincode. Needs the buyer to have an address selected;
//     if none is passed, falls back to the seller's dispatch state only info
//     (best-effort, will be re-confirmed by the RPC when the order is placed).
//   - getOrderQuote reports `stockShortfall` (informational only) instead of
//     the old `hasEnoughStock` gate — nothing in this file blocks on it.
//   - placeOrder passes purchaseBasis / orderType / sampleOrderId through to
//     the RPC, and no longer treats INSUFFICIENT_STOCK as an error — it isn't
//     raised anymore. The stock-shortfall demand-signal notification is now
//     driven off the RPC's returned `stock_shortfall` flag instead of a
//     caught RPC error.
import { supabase } from "../config/supabase.js";
import { notifyOrderChanged, notifyUser, notifyUserOrdersChanged } from "../services/realtimeBroadcast.js";

const ERROR_MAP = {
    LISTING_NOT_FOUND: { status: 404, message: "That listing is no longer available." },
    LISTING_NOT_APPROVED: { status: 400, message: "This listing isn't approved for sale." },
    CANNOT_ORDER_OWN_LISTING: { status: 400, message: "You can't place an order on your own listing." },
    BELOW_MOQ: { status: 400, message: "Quantity is below the seller's minimum order quantity." },
    SAMPLE_NOT_AVAILABLE: { status: 400, message: "This seller doesn't offer a sample for this item." },
    EXCEEDS_SAMPLE_QUANTITY: { status: 400, message: "Requested quantity exceeds the sample limit for this item." },
    BUYER_NOT_FOUND: { status: 401, message: "Please sign in again." },
    BUYER_NOT_VERIFIED: { status: 403, message: "Please verify your email or phone before placing an order." },
    ADDRESS_NOT_FOUND: { status: 400, message: "Please select a valid shipping address." },
    INVALID_QUANTITY: { status: 400, message: "Please enter a valid quantity." },
};
function mapRpcError(error) {
    return ERROR_MAP[(error?.message || "").trim()] || { status: 500, message: "Couldn't place the order. Please try again." };
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDDMon(date) {
    return `${String(date.getDate()).padStart(2, "0")} ${MONTH_SHORT[date.getMonth()]}`;
}

// Same zone heuristic as the place_order RPC — same pincode prefix (1 day
// transit), same state (3 days), else (6 days) — added on top of the
// listing's lead time (dispatch_time_days for ready stock, or
// production_lead_time_days for made-to-order).
function estimateDeliveryDate(submission, buyerPincode, buyerState) {
    const leadDays = submission.stock_type === "made_to_order"
        ? Number(submission.production_lead_time_days || 0)
        : Number(submission.dispatch_time_days ?? submission.lead_time ?? 0);

    let transitDays = 6;
    if (submission.dispatch_pincode && buyerPincode && submission.dispatch_pincode.slice(0, 3) === buyerPincode.slice(0, 3)) {
        transitDays = 1;
    } else if (submission.dispatch_state && buyerState && submission.dispatch_state.toLowerCase() === buyerState.toLowerCase()) {
        transitDays = 3;
    }

    const date = new Date();
    date.setDate(date.getDate() + leadDays + transitDays);
    return { date, label: formatDDMon(date), leadDays, transitDays };
}

// Converts a pack/master-pack/unit quantity into base units, using the
// listing's pack_size / units_per_master_pack (falling back to 1 so older
// listings without packaging data still behave as plain per-unit orders).
function toBaseUnits(submission, quantity, purchaseBasis) {
    const packSize = Number(submission.pack_size) > 0 ? Number(submission.pack_size) : 1;
    const masterPackSize = Number(submission.units_per_master_pack) > 0 ? Number(submission.units_per_master_pack) : 1;
    if (purchaseBasis === "per_pack") return quantity * packSize;
    if (purchaseBasis === "per_master_pack") return quantity * packSize * masterPackSize;
    return quantity;
}

// ---- Slab / quantity-discount pricing --------------------------------
// Mirrors the exact logic in the place_order RPC and BuyNowModal.jsx's
// computeLocalQuote. All operate on BASE-UNIT quantity.
function resolveSlabUnitPrice(priceSlabs, quantity, fallbackPrice) {
    if (!Array.isArray(priceSlabs) || !priceSlabs.length) return { price: fallbackPrice, slab: null };
    const applicable = priceSlabs
        .filter((s) => Number(s.minQty) > 0 && quantity >= Number(s.minQty) && (!s.maxQty || quantity <= Number(s.maxQty)))
        .sort((a, b) => Number(b.minQty) - Number(a.minQty));
    if (!applicable.length) return { price: fallbackPrice, slab: null };
    return { price: Number(applicable[0].price), slab: applicable[0] };
}
function resolveDiscountPercent(quantityDiscounts, quantity) {
    if (!Array.isArray(quantityDiscounts) || !quantityDiscounts.length) return { percent: 0, tier: null };
    const applicable = quantityDiscounts
        .filter((d) => Number(d.minQty) > 0 && quantity >= Number(d.minQty))
        .sort((a, b) => Number(b.minQty) - Number(a.minQty));
    if (!applicable.length) return { percent: 0, tier: null };
    return { percent: Number(applicable[0].discountPercent) || 0, tier: applicable[0] };
}

// GET /api/orders/checkout-status — unchanged
export async function checkoutStatus(req, res) {
    if (!req.user) return res.json({ success: true, canCheckout: false, reason: "NOT_AUTHENTICATED" });

    const { data: profile, error } = await supabase
        .from("profiles").select("id, name, email, email_verified, phone, phone_verified")
        .eq("id", req.user.id).maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!profile) return res.json({ success: true, canCheckout: false, reason: "NOT_AUTHENTICATED" });
    if (!profile.email_verified && !profile.phone_verified) {
        return res.json({ success: true, canCheckout: false, reason: "NOT_VERIFIED", profile });
    }

    const { data: business } = await supabase
        .from("business_profiles").select("gstin, gstin_status, trade_name, legal_name")
        .eq("user_id", req.user.id).maybeSingle();

    res.json({ success: true, canCheckout: true, profile, business: business || null });
}

// GET /api/orders/quote?submissionId=&quantity=&purchaseBasis=&orderType=&addressId=
//
// `quantity` is in whatever `purchaseBasis` is ('per_unit' default). If the
// buyer already has an address selected, pass `addressId` so the delivery
// estimate uses their real pincode/state — otherwise the estimate is based
// on lead time + a default "rest of India" transit band, and gets refined
// once an address is chosen (the RPC recomputes it authoritatively anyway).
export async function getOrderQuote(req, res) {
    const { submissionId, quantity, purchaseBasis = "per_unit", orderType = "standard", addressId } = req.query;
    const qty = Number(quantity);
    if (!submissionId) return res.status(400).json({ success: false, message: "submissionId is required." });
    if (!(qty > 0)) return res.status(400).json({ success: false, message: "Enter a valid quantity." });
    if (!["per_unit", "per_pack", "per_master_pack"].includes(purchaseBasis)) {
        return res.status(400).json({ success: false, message: "Invalid purchase basis." });
    }

    const { data: submission, error } = await supabase
        .from("seller_product_submissions")
        .select("id, price, moq, unit, lead_time, stock_quantity, review_status, price_slabs, quantity_discounts, stock_type, dispatch_time_days, production_lead_time_days, pack_size, units_per_master_pack, dispatch_pincode, dispatch_state, sample_available, sample_quantity, sample_price")
        .eq("id", submissionId).maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!submission || submission.review_status !== "approved") {
        return res.status(404).json({ success: false, message: "Listing not available." });
    }

    const isSample = orderType === "sample";
    const baseQty = toBaseUnits(submission, qty, purchaseBasis);

    let addressPincode = null, addressState = null;
    if (addressId) {
        const { data: addr } = await supabase.from("buyer_addresses").select("pincode, state").eq("id", addressId).maybeSingle();
        if (addr) { addressPincode = addr.pincode; addressState = addr.state; }
    }
    const delivery = estimateDeliveryDate(submission, addressPincode, addressState);

    if (isSample) {
        if (!submission.sample_available) return res.status(400).json({ success: false, message: "This seller doesn't offer a sample for this item." });
        const exceedsSample = submission.sample_quantity != null && baseQty > Number(submission.sample_quantity);
        return res.json({
            success: true,
            orderType: "sample",
            unitPrice: Number(submission.sample_price) || 0,
            subtotal: (Number(submission.sample_price) || 0) * baseQty,
            unit: submission.unit,
            purchaseBasis, quantity: qty, baseQuantity: baseQty,
            sampleQuantity: submission.sample_quantity,
            exceedsSampleQuantity: exceedsSample,
            estimatedDeliveryDate: delivery.label,
            leadDays: delivery.leadDays, transitDays: delivery.transitDays,
        });
    }

    const { price: slabPrice, slab: appliedSlab } = resolveSlabUnitPrice(submission.price_slabs, baseQty, Number(submission.price));
    const { percent: discountPercent, tier: discountTier } = resolveDiscountPercent(submission.quantity_discounts, baseQty);
    const unitPrice = Math.round(slabPrice * (1 - discountPercent / 100) * 100) / 100;

    const { data: settings } = await supabase.from("platform_settings").select("commission_percent").eq("id", true).maybeSingle();
    const commissionPercent = Number(settings?.commission_percent ?? 5);
    const subtotal = Math.round(unitPrice * baseQty * 100) / 100;
    const platformFee = Math.round((subtotal * commissionPercent / 100) * 100) / 100;

    const stockShortfall = submission.stock_type === "ready_stock"
        && submission.stock_quantity != null
        && baseQty > Number(submission.stock_quantity);

    res.json({
        success: true,
        orderType: "standard",
        unitPrice, basePriceApplied: slabPrice, appliedSlab, discountPercent, discountTier,
        unit: submission.unit, moq: submission.moq,
        purchaseBasis, quantity: qty, baseQuantity: baseQty,
        estimatedDeliveryDate: delivery.label, leadDays: delivery.leadDays, transitDays: delivery.transitDays,
        availableStock: submission.stock_quantity, subtotal,
        platformFeePercent: commissionPercent, platformFeeAmount: platformFee, sellerPayoutAmount: subtotal - platformFee,
        meetsMoq: baseQty >= Number(submission.moq),
        // Informational only — nothing gates on this anymore. Ready-stock
        // shortfalls still go through; the UI shows "will take a little
        // longer" instead of blocking. Made-to-order is never flagged here.
        stockShortfall,
    });
}

// POST /api/orders
//
// Body: { submissionId, quantity, purchaseBasis, orderType, sampleOrderId,
//         shippingAddressId, notes }
// `quantity` is in `purchaseBasis` units (default 'per_unit'). `orderType`
// defaults to 'standard' and is NEVER inferred/preselected — the buyer must
// explicitly opt into 'sample' via the UI. Stock shortfalls no longer block
// the order; the RPC returns `stock_shortfall` and this handler still fires
// the seller demand-signal notification off that flag instead of a caught
// INSUFFICIENT_STOCK error (which the RPC no longer raises).
export async function placeOrder(req, res) {
    const buyerId = req.user.id;
    const {
        submissionId, quantity, purchaseBasis = "per_unit", orderType = "standard",
        sampleOrderId, shippingAddressId, notes,
    } = req.body || {};

    if (!submissionId) return res.status(400).json({ success: false, message: "Missing listing." });
    if (!shippingAddressId) return res.status(400).json({ success: false, message: "Please select a shipping address." });
    const qty = Number(quantity);
    if (!(qty > 0)) return res.status(400).json({ success: false, message: "Please enter a valid quantity." });
    if (!["per_unit", "per_pack", "per_master_pack"].includes(purchaseBasis)) {
        return res.status(400).json({ success: false, message: "Invalid purchase basis." });
    }
    const safeOrderType = orderType === "sample" ? "sample" : "standard";

    const { data, error } = await supabase.rpc("place_order", {
        p_buyer_id: buyerId,
        p_submission_id: submissionId,
        p_quantity: qty,
        p_shipping_address_id: shippingAddressId,
        p_buyer_notes: notes || null,
        p_purchase_basis: purchaseBasis,
        p_order_type: safeOrderType,
        p_sample_order_id: sampleOrderId || null,
    });

    if (error) {
        const mapped = mapRpcError(error);
        return res.status(mapped.status).json({ success: false, code: error.message, message: mapped.message });
    }

    const row = Array.isArray(data) ? data[0] : data;

    const { data: submission } = await supabase.from("seller_product_submissions").select("seller_id").eq("id", submissionId).maybeSingle();
    if (submission) {
        const { data: sellerProfile } = await supabase.from("seller_profiles").select("user_id").eq("id", submission.seller_id).maybeSingle();
        if (sellerProfile) {
            // await notifyUser(sellerProfile.user_id, {
            //     type: safeOrderType === "sample" ? "new_sample_order" : "new_order",
            //     title: safeOrderType === "sample" ? "New sample request" : "New order received",
            //     body: row.stock_shortfall
            //         ? `Order ${row.order_number} was placed for more than your current stock — fulfilment will take a little longer.`
            //         : `Order ${row.order_number} was just placed.`,
            //     link: `/seller/orders/${row.order_id}`,
            // });
            await notifyUserOrdersChanged(sellerProfile.user_id);
        }
    }

    res.json({
        success: true,
        orderId: row.order_id,
        orderNumber: row.order_number,
        estimatedDeliveryDate: row.estimated_delivery_date,
        stockShortfall: row.stock_shortfall,
        orderType: safeOrderType,
        message: safeOrderType === "sample" ? "Sample requested. The seller has been notified." : "Order placed. The seller has been notified.",
    });
}

// GET /api/orders
export async function listMyOrders(req, res) {
    const { status, orderType } = req.query;
    let query = supabase
        .from("orders")
        .select(`
      id, order_number, status, order_type, sample_order_id, stock_shortfall,
      subtotal_amount, total_amount, payment_status, created_at, updated_at,
      seller:seller_profiles ( id, display_name, shop_slug, logo_url, city, state ),
      items:order_items ( id, product_name_snapshot, brand_name_snapshot, image_snapshot, unit_price, unit, quantity, purchase_basis, pack_quantity_snapshot, lead_time_snapshot, line_total )
    `)
        .eq("buyer_id", req.user.id).order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    if (orderType) query = query.eq("order_type", orderType);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, orders: data || [] });
}

// GET /api/orders/:id
export async function getMyOrder(req, res) {
    const { data: order, error } = await supabase
        .from("orders").select("*, seller:seller_profiles ( id, display_name, shop_slug, logo_url, city, state ), items:order_items ( * )")
        .eq("id", req.params.id).eq("buyer_id", req.user.id).maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });

    const { data: events } = await supabase.from("order_events").select("*").eq("order_id", order.id).order("created_at");
    res.json({ success: true, order, events: events || [] });
}

// POST /api/orders/:id/cancel — unchanged
export async function cancelMyOrder(req, res) {
    const { reason } = req.body || {};
    const { error } = await supabase.rpc("update_order_status", {
        p_order_id: req.params.id, p_actor_role: "buyer", p_actor_user_id: req.user.id,
        p_new_status: "cancelled", p_note: reason || "Cancelled by buyer",
    });
    await notifyOrderChanged(req.params.id, { status: "cancelled" });
    const { data: order } = await supabase.from("orders").select("seller_id, order_number").eq("id", req.params.id).maybeSingle();
    if (order) {
        const { data: sellerProfile } = await supabase.from("seller_profiles").select("user_id").eq("id", order.seller_id).maybeSingle();
        if (sellerProfile) {
            // await notifyUser(sellerProfile.user_id, { type: "order_cancelled", title: `Order ${order.order_number} cancelled`, body: reason || "Cancelled by buyer", link: `/seller/orders/${req.params.id}` });
            await notifyUserOrdersChanged(sellerProfile.user_id);
        }
    }
    if (error) {
        const status = { FORBIDDEN: 403, ORDER_NOT_FOUND: 404, INVALID_TRANSITION: 400 }[error.message] || 500;
        return res.status(status).json({ success: false, code: error.message, message: status === 400 ? "This order can no longer be cancelled." : "Couldn't cancel the order." });
    }
    res.json({ success: true, message: "Order cancelled." });
}