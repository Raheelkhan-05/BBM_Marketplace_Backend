// controllers/orders.controller.js — PATCH: de-duplicate notifications
//
// Root cause: place_order and update_order_status both INSERT into
// `notifications` directly as their last step (see the RPC SQL — the
// `insert into notifications (...)` block near the end of each). The
// controller was ALSO calling notifyUser(...) after every successful RPC
// call, producing two rows per event: the RPC's detailed one, and the
// controller's shorter duplicate.
//
// Fix: remove the controller-side notifyUser(...) calls for events the RPC
// already covers (order placed, cancelled/confirmed/rejected/etc. status
// changes). notifyOrderChanged / notifyUserOrdersChanged are UNCHANGED and
// kept — those are realtime channel broadcasts (no `notifications` row),
// not duplicates, and the UI's live-refresh depends on them.
//
// Only three functions in this file change: placeOrder, cancelMyOrder.
// getOrderQuote, checkoutStatus, listMyOrders, getMyOrder are untouched —
// reproduced below only for completeness so this is a drop-in replacement.
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

// Rough zone-to-zone transit day estimates based on PIN code first digit
// (1=Delhi/N, 2=Punjab/Haryana/UP-W, 3=Rajasthan/Gujarat, 4=Maharashtra/MP,
//  5=AP/Karnataka, 6=TN/Kerala, 7=WB/Odisha/NE, 8=Bihar/Jharkhand, 9=Army PO)
function estimateDeliveryDate(submission, buyerPincode, buyerState) {
    const leadDays = submission.stock_type === "made_to_order"
        ? Number(submission.production_lead_time_days || 0)
        : Number(submission.dispatch_time_days ?? submission.lead_time ?? 0);

    const transitDays = estimateTransitDays(
        submission.dispatch_pincode,
        submission.dispatch_state,
        buyerPincode,
        buyerState
    );

    const date = new Date();
    date.setDate(date.getDate() + leadDays + transitDays);
    return { date, label: formatDDMon(date), leadDays, transitDays };
}

function estimateTransitDays(originPincode, originState, destPincode, destState) {
    if (!originPincode || !destPincode) return 4; // unknown -> conservative fallback

    const originPrefix3 = originPincode.slice(0, 3);
    const destPrefix3 = destPincode.slice(0, 3);

    // Same local delivery zone (~city/nearby town) -> same-day/next-day
    if (originPrefix3 === destPrefix3) return 1;

    const originZone = Number(originPincode[0]);
    const destZone = Number(destPincode[0]);
    const sameState = originState && destState &&
        originState.trim().toLowerCase() === destState.trim().toLowerCase();

    // Same state, different city -> typically overnight to 1 day road transit
    if (sameState) return 2;

    const zoneDiff = Math.abs(originZone - destZone);

    // Neighbouring zone (e.g. Maharashtra <-> Gujarat) -> ~1 day road transit,
    // matches Mumbai -> Rajkot (~700km / ~15hrs) real-world case
    if (zoneDiff <= 1) return 2;

    // 2 zones apart -> ~2 days transit
    if (zoneDiff === 2) return 3;

    // 3 zones apart -> ~3 days transit
    if (zoneDiff === 3) return 4;

    // Far corners of the country (e.g. Gujarat <-> NE) -> ~4-5 days
    return zoneDiff >= 5 ? 6 : 5;
}

function toBaseUnits(submission, quantity, purchaseBasis) {
    const packSize = Number(submission.pack_size) > 0 ? Number(submission.pack_size) : 1;
    const masterPackSize = Number(submission.units_per_master_pack) > 0 ? Number(submission.units_per_master_pack) : 1;
    if (purchaseBasis === "per_pack") return quantity * packSize;
    if (purchaseBasis === "per_master_pack") return quantity * packSize * masterPackSize;
    return quantity;
}

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

// GET /api/orders/quote — unchanged
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
        stockShortfall,
    });
}

// POST /api/orders
//
// CHANGED: no longer calls notifyUser(...) on success. place_order already
// inserts the seller's "New order"/"New sample request" notification row
// itself (see the RPC's final `insert into notifications` block) — calling
// notifyUser here duplicated it. notifyUserOrdersChanged is KEPT: it's a
// realtime channel broadcast, not a notifications-table row, and
// SalesOrdersPage's live list depends on it firing.
//
// The one thing the RPC's own notification text can't express is the
// stock-shortfall context — its message is generic. Rather than add a
// second notifications row for that (which would reintroduce the same
// duplication problem), the shortfall is surfaced entirely client-side:
// SalesOrdersPage already reads orders.stock_shortfall directly and shows
// the amber banner from that column, so no extra notification is needed.
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
        console.error("place_order RPC failed:", error); // check .message, .details, .hint, .code in your terminal
        const mapped = mapRpcError(error);
        return res.status(mapped.status).json({ success: false, code: error.message, message: mapped.message });
    }


    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
        console.error("place_order RPC returned no row", { submissionId, orderType: safeOrderType, data });
        return res.status(500).json({ success: false, message: "Couldn't place the order — please try again." });
    }

    // Realtime broadcast only — NOT a notifications-table insert, so this
    // doesn't duplicate what the RPC already wrote. Kept so the seller's
    // SalesOrdersPage list updates live.
    const { data: submission } = await supabase.from("seller_product_submissions").select("seller_id").eq("id", submissionId).maybeSingle();
    if (submission) {
        const { data: sellerProfile } = await supabase.from("seller_profiles").select("user_id").eq("id", submission.seller_id).maybeSingle();
        if (sellerProfile) {
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

// GET /api/orders — unchanged
export async function listMyOrders(req, res) {
    const { status, orderType } = req.query;
    let query = supabase
        .from("orders")
        .select(`
      id, order_number, status, order_type, sample_order_id, stock_shortfall,
      subtotal_amount, total_amount, payment_status, created_at, updated_at,
      seller:seller_profiles ( id, display_name, shop_slug, logo_url, city, state ),
      items:order_items ( id, product_name_snapshot, brand_name_snapshot, image_snapshot, unit_price, base_price_applied, discount_percent, unit, quantity, purchase_basis, pack_quantity_snapshot, lead_time_snapshot, line_total )
    `)
        .eq("buyer_id", req.user.id).order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    if (orderType) query = query.eq("order_type", orderType);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, orders: data || [] });
}

// GET /api/orders/:id — unchanged
export async function getMyOrder(req, res) {
    const { data: order, error } = await supabase
        .from("orders").select("*, seller:seller_profiles ( id, display_name, shop_slug, logo_url, city, state ), items:order_items ( * )")
        .eq("id", req.params.id).eq("buyer_id", req.user.id).maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });

    const { data: events } = await supabase.from("order_events").select("*").eq("order_id", order.id).order("created_at");
    res.json({ success: true, order, events: events || [] });
}

// POST /api/orders/:id/cancel
//
// CHANGED: removed the notifyUser(...) call. update_order_status already
// inserts a notifications row for the counterpart (buyer→seller here)
// as its last step — see the RPC's `if p_actor_role = 'seller' then ... else
// insert into notifications (... 'Buyer updated order status ...') end if`
// block. notifyOrderChanged (realtime broadcast) and notifyUserOrdersChanged
// are kept — same reasoning as placeOrder above.
export async function cancelMyOrder(req, res) {
    const { reason } = req.body || {};
    const { error } = await supabase.rpc("update_order_status", {
        p_order_id: req.params.id, p_actor_role: "buyer", p_actor_user_id: req.user.id,
        p_new_status: "cancelled", p_note: reason || "Cancelled by buyer",
    });

    if (error) {
        const status = { FORBIDDEN: 403, ORDER_NOT_FOUND: 404, INVALID_TRANSITION: 400 }[error.message] || 500;
        return res.status(status).json({ success: false, code: error.message, message: status === 400 ? "This order can no longer be cancelled." : "Couldn't cancel the order." });
    }

    await notifyOrderChanged(req.params.id, { status: "cancelled" });
    const { data: order } = await supabase.from("orders").select("seller_id, order_number").eq("id", req.params.id).maybeSingle();
    if (order) {
        const { data: sellerProfile } = await supabase.from("seller_profiles").select("user_id").eq("id", order.seller_id).maybeSingle();
        if (sellerProfile) {
            await notifyUserOrdersChanged(sellerProfile.user_id);
        }
    }
    res.json({ success: true, message: "Order cancelled." });
}