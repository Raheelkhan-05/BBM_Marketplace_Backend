// controllers/orders.controller.js — PATCH: de-duplicate notifications +
// simplified distance-based delivery estimate + buyer-seller transport
// preference snapshotting.
//
// De-dup notification fix (unchanged from before): place_order and
// update_order_status both INSERT into `notifications` directly as their
// last step. The controller no longer calls notifyUser(...) after those
// RPCs for events the RPC already covers. notifyOrderChanged /
// notifyUserOrdersChanged are UNCHANGED and kept — those are realtime
// channel broadcasts (no `notifications` row), not duplicates.
//
// Delivery estimate is a simple distance / speed model: fetch the road
// distance (km) between the seller's dispatch pincode and the buyer's
// pincode, assume a flat transport speed of 15 km/h, and convert that to
// a day range (floor/ceil of the raw day count). When we have no
// road-distance data for a pincode pair, we fall back to a rough km guess
// from a zone heuristic, then run THAT through the same distance -> days
// formula, so there's only one place day counts are ever computed from.
//
// NEW: placeOrder now accepts transportMode/transportCompany/transportDetails
// from the client (BuyNowModal reads the buyer-seller pair's confirmed
// transport preference, if any, and forwards it here) and passes them
// through to the place_order RPC, which snapshots them onto the order row
// atomically along with everything else. See place_order's p_transport_*
// params and the transport_mode/transport_company/transport_details/
// transport_source columns on `orders`.
import { supabase } from "../config/supabase.js";
import { notifyUser, notifyOrderChanged, notifyUserOrdersChanged } from "../services/realtimeBroadcast.js";

import { getRoadDistanceKm } from "../services/pincodeDistance.js";
import { purchaseQtyToSaleUnitQty, saleUnitQtyToBaseUnits, getSaleUnit, round2 } from "../../shared/packUnits.js";


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
    OUT_OF_STOCK: { status: 400, message: "This item is currently out of stock." },
};
function mapRpcError(error) {
    return ERROR_MAP[(error?.message || "").trim()] || { status: 500, message: "Couldn't place the order. Please try again." };
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDDMon(date) {
    return `${String(date.getDate()).padStart(2, "0")} ${MONTH_SHORT[date.getMonth()]}`;
}

async function assertSellerAcceptingOrders(sellerId) {
    const { data, error } = await supabase.rpc("wallet_get_status", { p_seller_id: sellerId }).single();
    if (error) return null; // fail open on infra error — don't block buyers over a wallet read failure
    if (data?.is_blocked) {
        const reason = data.blocked_reason === "monthly_unpaid"
            ? "This seller has an unpaid monthly platform balance and isn't accepting new orders right now."
            : "This seller has reached their order limit and isn't accepting new orders right now.";
        return reason;
    }
    return null;
}

// ---------------------------------------------------------------------
// Distance-based transit estimate
// ---------------------------------------------------------------------
const TRANSPORT_SPEED_KMH = 15;

function daysFromDistance(km) {
    const hours = km / TRANSPORT_SPEED_KMH;
    const rawDays = hours / 24;
    const min = Math.floor(rawDays);
    const max = Math.ceil(rawDays);
    return { min: min === max ? min : min, max: max === min ? min : max };
}

function estimateFallbackKm(originPincode, originState, destPincode, destState) {
    if (!originPincode || !destPincode) return 600;

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
    if (originPrefix3 && originPrefix3 === destPrefix3) return { min: 1, max: 1 };

    const km = await getRoadDistanceKm(originPincode, destPincode);
    if (km == null) {
        const fallbackKm = estimateFallbackKm(originPincode, originState, destPincode, destState);
        return daysFromDistance(fallbackKm);
    }
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

    const label = transitMin === transitMax
        ? formatDDMon(dateMin)
        : `${formatDDMon(dateMin)} - ${formatDDMon(dateMax)}`;

    return {
        dateMin, dateMax, label,
        leadDays, transitDaysMin: transitMin, transitDaysMax: transitMax,
    };
}

function toBaseUnits(submission, quantity, purchaseBasis) {
    const packSize = Number(submission.pack_size) > 0 ? Number(submission.pack_size) : 1;
    const masterPackSize = Number(submission.units_per_master_pack) > 0 ? Number(submission.units_per_master_pack) : 1;
    if (purchaseBasis === "per_pack") return quantity * packSize;
    if (purchaseBasis === "per_master_pack") return quantity * packSize * masterPackSize;
    return quantity;
}

function toPackQty(submission, quantity, purchaseBasis) {
    const masterPackSize = Number(submission.units_per_master_pack) > 0 ? Number(submission.units_per_master_pack) : 1;
    if (purchaseBasis === "per_master_pack") return quantity * masterPackSize;
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

// GET /api/orders/checkout-status
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

// GET /api/orders/quote
export async function getOrderQuote(req, res) {
    const { submissionId, quantity, purchaseBasis = "per_pack", orderType = "standard", addressId } = req.query;
    const qty = Number(quantity);
    if (!submissionId) return res.status(400).json({ success: false, message: "submissionId is required." });
    if (!(qty > 0)) return res.status(400).json({ success: false, message: "Enter a valid quantity." });

    const { data: sellerRow } = await supabase.from("seller_product_submissions").select("seller_id").eq("id", submissionId).maybeSingle();
    if (sellerRow) {
        const blockMsg = await assertSellerAcceptingOrders(sellerRow.seller_id);
        if (blockMsg) return res.status(403).json({ success: false, code: "SELLER_BLOCKED", message: blockMsg });
    }

    const isSample = orderType === "sample";
    const allowedBases = isSample ? ["per_unit", "per_pack", "per_master_pack"] : ["per_pack", "per_master_pack"];
    if (!allowedBases.includes(purchaseBasis)) {
        return res.status(400).json({ success: false, message: "Invalid purchase basis." });
    }

    const { data: submission, error } = await supabase
        .from("seller_product_submissions")
        .select("id, price, moq, unit, lead_time, stock_quantity, review_status, price_slabs, quantity_discounts, stock_type, dispatch_time_days, production_lead_time_days, pack_size, units_per_master_pack, dispatch_pincode, dispatch_state, sample_available, sample_quantity, sample_price, generic_product_brand_id")
        .eq("id", submissionId).maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!submission || submission.review_status !== "approved") {
        return res.status(404).json({ success: false, message: "Listing not available." });
    }

    const saleQty = purchaseQtyToSaleUnitQty(qty, purchaseBasis, submission.pack_size, submission.units_per_master_pack);
    const baseQty = saleUnitQtyToBaseUnits(saleQty, submission.pack_size, submission.units_per_master_pack);

    const packQty = toPackQty(submission, qty, purchaseBasis);

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

    const pricePerSaleUnit = Number(submission.price);

    const { price: slabPrice, slab: appliedSlab } = resolveSlabUnitPrice(submission.price_slabs, saleQty, pricePerSaleUnit);
    const { percent: discountPercent, tier: discountTier } = resolveDiscountPercent(submission.quantity_discounts, saleQty);
    const unitPrice = round2(slabPrice * (1 - discountPercent / 100));

    const { data: commissionPercentData } = await supabase
        .rpc("resolve_commission_percent", { p_generic_product_brand_id: submission.generic_product_brand_id });
    const commissionPercent = Number(commissionPercentData ?? 0.25);

    const subtotal = round2(unitPrice * saleQty);
    const platformFee = round2(subtotal * commissionPercent / 100);

    const stockShortfall = submission.stock_type === "ready_stock"
        && submission.stock_quantity != null
        && saleQty > Number(submission.stock_quantity);

    const outOfStock = submission.stock_type === "ready_stock"
        && submission.stock_quantity != null
        && Number(submission.stock_quantity) <= 0;

    res.json({
        success: true,
        orderType: "standard",
        unitPrice, basePriceApplied: slabPrice, appliedSlab, discountPercent, discountTier,
        unit: submission.unit, moq: submission.moq,
        saleUnit: getSaleUnit(submission.units_per_master_pack),
        purchaseBasis, quantity: qty, saleUnitQuantity: saleQty,
        estimatedDeliveryDate: delivery.label, leadDays: delivery.leadDays,
        transitDaysMin: delivery.transitDaysMin, transitDaysMax: delivery.transitDaysMax,
        availableStock: submission.stock_quantity, subtotal,
        platformFeePercent: commissionPercent, platformFeeAmount: platformFee, sellerPayoutAmount: subtotal - platformFee,
        meetsMoq: saleQty >= Number(submission.moq),
        stockShortfall,
        outOfStock,
    });
}

// POST /api/orders
export async function placeOrder(req, res) {
    const buyerId = req.user.id;
    const {
        submissionId, quantity, purchaseBasis = "per_unit", orderType = "standard",
        sampleOrderId, shippingAddressId, notes,
        transportMode, transportCompany, transportDetails,
    } = req.body || {};

    if (!submissionId) return res.status(400).json({ success: false, message: "Missing listing." });
    if (!shippingAddressId) return res.status(400).json({ success: false, message: "Please select a shipping address." });
    const qty = Number(quantity);
    if (!(qty > 0)) return res.status(400).json({ success: false, message: "Please enter a valid quantity." });
    if (!["per_unit", "per_pack", "per_master_pack"].includes(purchaseBasis)) {
        return res.status(400).json({ success: false, message: "Invalid purchase basis." });
    }
    const safeOrderType = orderType === "sample" ? "sample" : orderType === "credit" ? "credit" : "standard";

    const { data: sellerRow } = await supabase.from("seller_product_submissions").select("seller_id").eq("id", submissionId).maybeSingle();
    if (sellerRow) {
        const blockMsg = await assertSellerAcceptingOrders(sellerRow.seller_id);
        if (blockMsg) return res.status(403).json({ success: false, code: "SELLER_BLOCKED", message: blockMsg });
    }

    if (safeOrderType !== "sample") {
        const { data: submission } = await supabase
            .from("seller_product_submissions")
            .select("stock_type, stock_quantity")
            .eq("id", submissionId)
            .maybeSingle();

        if (submission?.stock_type === "ready_stock" && Number(submission.stock_quantity) <= 0) {
            return res.status(400).json({ success: false, code: "OUT_OF_STOCK", message: "This item is currently out of stock." });
        }
    }

    const { data, error } = await supabase.rpc("place_order", {
        p_buyer_id: buyerId,
        p_submission_id: submissionId,
        p_quantity: qty,
        p_shipping_address_id: shippingAddressId,
        p_buyer_notes: notes || null,
        p_purchase_basis: purchaseBasis,
        p_order_type: safeOrderType,
        p_sample_order_id: sampleOrderId || null,
        p_transport_mode: transportMode || null,
        p_transport_company: transportCompany || null,
        p_transport_details: transportDetails || null,
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

    if (row.order_status !== "awaiting_payment") {
        if (row.seller_user_id) {
            await notifyUser(row.seller_user_id, {
                type: "order_placed",
                title: `New order: ${row.order_number}`,
                body: "A buyer placed a new order. Check your Sales Orders to confirm it.",
                link: `/seller/orders/${row.order_id}`,
            });
        }

        const { data: submission } = await supabase.from("seller_product_submissions").select("seller_id").eq("id", submissionId).maybeSingle();
        if (submission) {
            const { data: sellerProfile } = await supabase.from("seller_profiles").select("user_id").eq("id", submission.seller_id).maybeSingle();
            if (sellerProfile) {
                await notifyUserOrdersChanged(sellerProfile.user_id);
            }
        }

        await supabase.rpc("wallet_accrue_commission", { p_order_id: row.order_id });
    }

    res.json({
        success: true,
        orderId: row.order_id,
        orderNumber: row.order_number,
        orderStatus: row.order_status,
        estimatedDeliveryDate: row.estimated_delivery_date,
        stockShortfall: row.stock_shortfall,
        paymentMethod: row.payment_method,
        orderType: safeOrderType,
        message: row.order_status === "awaiting_payment"
            ? "Order created. Complete the payment to confirm it."
            : (safeOrderType === "sample" ? "Sample requested. The seller has been notified." : "Order placed. The seller has been notified."),
    });
}

// GET /api/orders
export async function listMyOrders(req, res) {
    const { status, orderType } = req.query;
    let query = supabase
        .from("orders")
        .select(`
      id, order_number, status, order_type, sample_order_id, stock_shortfall,
      order_group_id,
      order_group:order_groups ( group_number ),
      subtotal_amount, total_amount, payment_status, created_at, updated_at,
      transport_mode, transport_company, transport_details, transport_source,
      seller:seller_profiles ( id, display_name, shop_slug, logo_url, city, state ),
      items:order_items ( id, product_name_snapshot, brand_name_snapshot, image_snapshot, unit_price, base_price_applied, discount_percent, unit, quantity, purchase_basis, pack_quantity_snapshot, lead_time_snapshot, line_total )
    `)
        .eq("buyer_id", req.user.id).order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    if (orderType) query = query.eq("order_type", orderType);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    const orders = (data || []).map((o) => ({ ...o, group_number: o.order_group?.group_number || null }));
    res.json({ success: true, orders });
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

// POST /api/orders/:id/cancel
export async function cancelMyOrder(req, res) {
    const { reason } = req.body || {};
    const { data, error } = await supabase.rpc("update_order_status", {
        p_order_id: req.params.id, p_actor_role: "buyer", p_actor_user_id: req.user.id,
        p_new_status: "cancelled", p_note: reason || "Cancelled by buyer",
    });

    if (error) {
        const status = { FORBIDDEN: 403, ORDER_NOT_FOUND: 404, INVALID_TRANSITION: 400 }[error.message] || 500;
        return res.status(status).json({ success: false, code: error.message, message: status === 400 ? "This order can no longer be cancelled." : "Couldn't cancel the order." });
    }

    const row = Array.isArray(data) ? data[0] : data;

    await notifyOrderChanged(req.params.id, { status: "cancelled" });
    await supabase.rpc("wallet_reverse_commission", { p_order_id: req.params.id });

    if (row?.notify_user_id) {
        await notifyUser(row.notify_user_id, {
            type: "order_status_cancelled",
            title: `Order ${row.order_number} cancelled`,
            body: reason || "The buyer cancelled this order.",
            link: `/seller/orders/${req.params.id}`,
        });
        await notifyUserOrdersChanged(row.notify_user_id);
    }
    res.json({ success: true, message: "Order cancelled." });
}