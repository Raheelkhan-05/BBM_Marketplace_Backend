// controllers/orders.controller.js — PATCH: de-duplicate notifications +
// simplified distance-based delivery estimate.
//
// De-dup notification fix (unchanged from before): place_order and
// update_order_status both INSERT into `notifications` directly as their
// last step. The controller no longer calls notifyUser(...) after those
// RPCs for events the RPC already covers. notifyOrderChanged /
// notifyUserOrdersChanged are UNCHANGED and kept — those are realtime
// channel broadcasts (no `notifications` row), not duplicates.
//
// NEW: delivery estimate is now a simple distance / speed model instead of
// banded heuristics. We fetch the road distance (km) between the seller's
// dispatch pincode and the buyer's pincode, assume a flat transport speed
// of 15 km/h, and convert that to a day range (floor/ceil of the raw day
// count). Example: 1000km / 15km/h = 66.67h = 2.78 days -> shown as
// "+2 to +3 days" on top of the seller's own lead time. When we have no
// road-distance data for a pincode pair, we fall back to a rough km guess
// from the same zone heuristic used before, then run THAT through the
// same distance -> days formula, so there's only one place day counts are
// ever computed from.
import { supabase } from "../config/supabase.js";
import { notifyOrderChanged, notifyUser, notifyUserOrdersChanged } from "../services/realtimeBroadcast.js";
import { getRoadDistanceKm } from "../services/pincodeDistance.js";

const ERROR_MAP = {
    LISTING_NOT_FOUND: { status: 404, message: "That listing is no longer available." },
    LISTING_NOT_APPROVED: { status: 400, message: "This listing isn't approved for sale." },
    CANNOT_ORDER_OWN_LISTING: { status: 400, message: "You can't place an order on your own listing." },
    BELOW_MOQ: { status: 400, message: "Quantity is below the seller's minimum order quantity." },
    SAMPLE_NOT_AVAILABLE: { status: 400, message: "This seller doesn't offer a sample for this item." },
    EXCEEDS_SAMPLE_QUANTITY: { status: 400, message: "Requested quantity exceeds the sample limit for this item." },
    CREDIT_NOT_APPROVED: { status: 403, message: "You don't have approved credit with this seller." },
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

// ---------------------------------------------------------------------
// Distance-based transit estimate
// ---------------------------------------------------------------------
const TRANSPORT_SPEED_KMH = 15;

// Converts a km distance into a [min, max] day range by dividing by the
// flat transport speed and taking floor/ceil of the resulting day count.
// e.g. 1000km / 15km/h = 66.67h = 2.78 days -> { min: 2, max: 3 }.
function daysFromDistance(km) {
    const hours = km / TRANSPORT_SPEED_KMH;
    const rawDays = hours / 24;
    const min = Math.floor(rawDays);
    const max = Math.ceil(rawDays);
    // Collapse to a single value when there's no meaningful fractional part
    // (e.g. exactly 2 days), or when transit is under a day (0-1 -> just "1").
    return { min: min === max ? min : min, max: max === min ? min : max };
}

// Rough km guess used only when we have no road-distance data for a
// pincode pair (missing from geo table). Mirrors the old zone-diff signal
// (1=Delhi/N, 2=Punjab/Haryana/UP-W, 3=Rajasthan/Gujarat, 4=Maharashtra/MP,
// 5=AP/Karnataka, 6=TN/Kerala, 7=WB/Odisha/NE, 8=Bihar/Jharkhand, 9=Army PO)
// but expressed as km so it still flows through the single
// distance -> days formula above, rather than having its own day logic.
function estimateFallbackKm(originPincode, originState, destPincode, destState) {
    if (!originPincode || !destPincode) return 600; // unknown -> conservative middle guess

    const originPrefix3 = originPincode.slice(0, 3);
    const destPrefix3 = destPincode.slice(0, 3);
    if (originPrefix3 === destPrefix3) return 60;

    const sameState = originState && destState &&
        originState.trim().toLowerCase() === destState.trim().toLowerCase();
    if (sameState) return 250;

    const originZone = Number(originPincode[0]);
    const destZone = Number(destPincode[0]);
    const zoneDiff = Math.abs(originZone - destZone);

    if (zoneDiff <= 1) return 700;
    if (zoneDiff === 2) return 1200;
    return 1900;
}

async function estimateTransitDayRange(originPincode, originState, destPincode, destState) {
    const originPrefix3 = originPincode?.slice(0, 3);
    const destPrefix3 = destPincode?.slice(0, 3);
    if (originPrefix3 && originPrefix3 === destPrefix3) return { min: 1, max: 1 }; // same local zone, skip distance lookup

    const km = await getRoadDistanceKm(originPincode, destPincode);
    if (km == null) {
        // pincode not in our geo table (rare, or missing data) — fall back
        // to a rough km guess rather than guessing days directly, so the
        // 15km/h formula is still the single source of truth for days.
        const fallbackKm = estimateFallbackKm(originPincode, originState, destPincode, destState);
        return daysFromDistance(fallbackKm);
    }

    // console.log("originPincode : ", originPincode);
    // console.log("destPincode : ", destPincode);

    // console.log("Distance : ", km);


    return daysFromDistance(km);
}

async function estimateDeliveryDate(submission, buyerPincode, buyerState) {
    const leadDays = submission.stock_type === "made_to_order"
        ? Number(submission.production_lead_time_days || 0)
        : Number(submission.dispatch_time_days ?? submission.lead_time ?? 0);

    const { min: transitMin, max: transitMax } = await estimateTransitDayRange(
        submission.dispatch_pincode,
        submission.dispatch_state,
        buyerPincode,
        buyerState
    );

    const dateMin = new Date();
    dateMin.setDate(dateMin.getDate() + leadDays + transitMin);
    const dateMax = new Date();
    dateMax.setDate(dateMax.getDate() + leadDays + transitMax);

    // Single date when min/max transit days collapse to the same value
    // (e.g. same local zone), otherwise a "23 Aug - 25 Aug" style range.
    const label = transitMin === transitMax
        ? formatDDMon(dateMin)
        : `${formatDDMon(dateMin)} - ${formatDDMon(dateMax)}`;

    return {
        dateMin, dateMax, label,
        leadDays, transitDaysMin: transitMin, transitDaysMax: transitMax,
    };
}

// toBaseUnits is no longer used in getOrderQuote (stock is tracked in
// Packs too, same as pricing/MOQ/discounts) — kept only if some other
// caller still needs true base-unit counts elsewhere.
function toBaseUnits(submission, quantity, purchaseBasis) {
    const packSize = Number(submission.pack_size) > 0 ? Number(submission.pack_size) : 1;
    const masterPackSize = Number(submission.units_per_master_pack) > 0 ? Number(submission.units_per_master_pack) : 1;
    if (purchaseBasis === "per_pack") return quantity * packSize;
    if (purchaseBasis === "per_master_pack") return quantity * packSize * masterPackSize;
    return quantity;
}

// Pack is the atomic unit for pricing, MOQ, discounts, AND stock.
function toPackQty(submission, quantity, purchaseBasis) {
    const masterPackSize = Number(submission.units_per_master_pack) > 0 ? Number(submission.units_per_master_pack) : 1;
    if (purchaseBasis === "per_master_pack") return quantity * masterPackSize;
    return quantity; // per_pack — quantity is already a pack count
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

// GET /api/orders/quote — unchanged shape, delivery fields updated to
// transitDaysMin/transitDaysMax (see estimateDeliveryDate above).
export async function getOrderQuote(req, res) {
    const { submissionId, quantity, purchaseBasis = "per_pack", orderType = "standard", addressId } = req.query;
    const qty = Number(quantity);
    if (!submissionId) return res.status(400).json({ success: false, message: "submissionId is required." });
    if (!(qty > 0)) return res.status(400).json({ success: false, message: "Enter a valid quantity." });

    const isSample = orderType === "sample";
    // Sample orders are still expressed in base units ("per_unit") — only
    // standard orders are restricted to Pack/Master Pack basis now that
    // pricing, MOQ, and stock are all tracked in Packs.
    const allowedBases = isSample ? ["per_unit", "per_pack", "per_master_pack"] : ["per_pack", "per_master_pack"];
    if (!allowedBases.includes(purchaseBasis)) {
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

    const baseQty = toBaseUnits(submission, qty, purchaseBasis); // stock checks only
    const packQty = toPackQty(submission, qty, purchaseBasis); // pricing / MOQ / discounts


    let addressPincode = null, addressState = null;
    if (addressId) {
        const { data: addr } = await supabase.from("buyer_addresses").select("pincode, state").eq("id", addressId).maybeSingle();
        if (addr) { addressPincode = addr.pincode; addressState = addr.state; }
    }
    const delivery = await estimateDeliveryDate(submission, addressPincode, addressState);

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
            leadDays: delivery.leadDays, transitDaysMin: delivery.transitDaysMin, transitDaysMax: delivery.transitDaysMax,
        });
    }

    const { price: slabPrice, slab: appliedSlab } = resolveSlabUnitPrice(submission.price_slabs, packQty, Number(submission.price));
    const { percent: discountPercent, tier: discountTier } = resolveDiscountPercent(submission.quantity_discounts, packQty);
    const unitPrice = Math.round(slabPrice * (1 - discountPercent / 100) * 100) / 100;

    const { data: settings } = await supabase.from("platform_settings").select("commission_percent").eq("id", true).maybeSingle();
    const commissionPercent = Number(settings?.commission_percent ?? 5);
    const subtotal = Math.round(unitPrice * packQty * 100) / 100;
    const platformFee = Math.round((subtotal * commissionPercent / 100) * 100) / 100;

    const stockShortfall = submission.stock_type === "ready_stock"
        && submission.stock_quantity != null
        && packQty > Number(submission.stock_quantity); // ← was baseQty, now packQty

    res.json({
        success: true,
        orderType: "standard",
        unitPrice, basePriceApplied: slabPrice, appliedSlab, discountPercent, discountTier,
        unit: submission.unit, moq: submission.moq,
        purchaseBasis, quantity: qty, baseQuantity: packQty, // NOTE: baseQuantity now reports pack-equivalent qty, see below
        estimatedDeliveryDate: delivery.label, leadDays: delivery.leadDays,
        transitDaysMin: delivery.transitDaysMin, transitDaysMax: delivery.transitDaysMax,
        availableStock: submission.stock_quantity, subtotal,
        platformFeePercent: commissionPercent, platformFeeAmount: platformFee, sellerPayoutAmount: subtotal - platformFee,
        meetsMoq: packQty >= Number(submission.moq),
        stockShortfall,
    });
}

// POST /api/orders — unchanged (see file header for the notification de-dup note)
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
    const safeOrderType = orderType === "sample" ? "sample" : orderType === "credit" ? "credit" : "standard";

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
        console.error("place_order RPC failed:", error);
        const mapped = mapRpcError(error);
        return res.status(mapped.status).json({ success: false, code: error.message, message: mapped.message });
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
        console.error("place_order RPC returned no row", { submissionId, orderType: safeOrderType, data });
        return res.status(500).json({ success: false, message: "Couldn't place the order — please try again." });
    }


    // row.order_status is 'awaiting_payment' for standard orders (gated on
    // UPI verification) or 'pending_confirmation' for sample/credit (which
    // skip the gate). Only broadcast the seller's live "orders changed" realtime
    // event for the latter — standard orders' seller broadcast now fires from
    // admin_verify_payment() instead, once payment is actually confirmed.
    if (row.order_status !== "awaiting_payment") {
        const { data: submission } = await supabase.from("seller_product_submissions").select("seller_id").eq("id", submissionId).maybeSingle();
        if (submission) {
            const { data: sellerProfile } = await supabase.from("seller_profiles").select("user_id").eq("id", submission.seller_id).maybeSingle();
            if (sellerProfile) {
                await notifyUserOrdersChanged(sellerProfile.user_id);
            }
        }
    }

    res.json({
        success: true,
        orderId: row.order_id,
        orderNumber: row.order_number,
        orderStatus: row.order_status,       // NEW — "awaiting_payment" | "pending_confirmation"
        estimatedDeliveryDate: row.estimated_delivery_date,
        stockShortfall: row.stock_shortfall,
        paymentMethod: row.payment_method,
        orderType: safeOrderType,
        message: row.order_status === "awaiting_payment"
            ? "Order created. Complete the payment to confirm it."
            : (safeOrderType === "sample" ? "Sample requested. The seller has been notified." : "Order placed. The seller has been notified."),
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

// POST /api/orders/:id/cancel — unchanged (see file header for the notification de-dup note)
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