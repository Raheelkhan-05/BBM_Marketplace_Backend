// controllers/orders.controller.js
import { supabase } from "../config/supabase.js";
import { notifyUser, notifyOrderChanged, notifyUserOrdersChanged } from "../services/realtimeBroadcast.js";
import { sendOrderUpdateWhatsApp } from "../services/whatsapp.service.js";
import { notifyIfWalletJustBlocked } from "../services/walletNotifications.service.js";

import { getRoadDistanceKm } from "../services/pincodeDistance.js";
import { purchaseQtyToSaleUnitQty, saleUnitQtyToBaseUnits, getSaleUnit, saleUnitLabel, round2 } from "../../shared/packUnits.js";

import { checkOrderWindow, checkLocationServiceable } from "../../shared/orderConstraints.js";


const ERROR_MAP = {
    LISTING_NOT_FOUND: { status: 404, message: "That listing is no longer available." },
    LISTING_NOT_APPROVED: { status: 400, message: "This listing isn't approved for sale." },
    CANNOT_ORDER_OWN_LISTING: { status: 400, message: "You can't place an order on your own listing." },
    BELOW_MOQ: { status: 400, message: "Quantity is below the seller's minimum order quantity." },
    SAMPLE_NOT_AVAILABLE: { status: 400, message: "This seller doesn't offer a sample for this item." },
    EXCEEDS_SAMPLE_QUANTITY: { status: 400, message: "Requested quantity exceeds the sample limit for this item." },
    EXCEEDS_AVAILABLE_STOCK: { status: 400, message: "That quantity isn't available from this seller." },
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

// ---------------------------------------------------------------------
// Distance-based transit estimate — unchanged, plus acceptanceDelayDays
// now folds into the total before building dateMin/dateMax.
// ---------------------------------------------------------------------
async function estimateDeliveryDate(submission, buyerPincode, buyerState, acceptanceDelayDays = 0) {
    const leadDays = submission.stock_type === "made_to_order"
        ? Number(submission.production_lead_time_days || 0)
        : Number(submission.dispatch_time_days ?? submission.lead_time ?? 0);

    const { min: transitMin, max: transitMax } = await estimateTransitDayRange(
        submission.dispatch_pincode,
        submission.dispatch_state,
        buyerPincode,
        buyerState
    );

    const totalMin = acceptanceDelayDays + leadDays + transitMin;
    const totalMax = acceptanceDelayDays + leadDays + transitMax;

    const dateMin = new Date();
    dateMin.setDate(dateMin.getDate() + totalMin);
    const dateMax = new Date();
    dateMax.setDate(dateMax.getDate() + totalMax);

    // Same floor/ceil-range convention as the existing transit range: if
    // the total isn't a single fixed number, show it as a range.
    const label = totalMin === totalMax
        ? formatDDMon(dateMin)
        : `${formatDDMon(dateMin)} - ${formatDDMon(dateMax)}`;

    return {
        dateMin, dateMax, label,
        acceptanceDelayDays,
        leadDays,
        transitDaysMin: transitMin,
        transitDaysMax: transitMax,
    };
}

// Small helper so getOrderQuote / placeOrder don't duplicate the
// "fetch seller working profile -> checkOrderWindow" plumbing.
async function getAcceptanceWindow(submissionId, now = new Date()) {
    const { data } = await supabase
        .from("seller_product_submissions")
        .select("seller:seller_profiles!seller_product_submissions_seller_id_fkey ( working_days, order_acceptance_start, order_acceptance_end, holidays )")
        .eq("id", submissionId)
        .maybeSingle();

    return checkOrderWindow({
        workingDays: data?.seller?.working_days,
        orderAcceptanceStart: data?.seller?.order_acceptance_start,
        orderAcceptanceEnd: data?.seller?.order_acceptance_end,
        holidays: data?.seller?.holidays,
    }, now);
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

// Shared stock-limit check — used by both the quote endpoint (to warn/
// disable in the UI) and placeOrder (to actually block the order).
// Returns { exceedsStock, availableStock } — exceedsStock is only ever
// true for ready_stock listings with a known stock_quantity; made_to_order
// listings and listings with no stock cap set have nothing to exceed.
function checkStockLimit(submission, saleQty) {
    const availableStock = submission.stock_type === "ready_stock" ? submission.stock_quantity : null;
    const exceedsStock = availableStock != null && saleQty > Number(availableStock);
    return { exceedsStock, availableStock };
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

    let addressPincode = null, addressState = null;
    if (addressId) {
        const { data: addr } = await supabase.from("buyer_addresses").select("pincode, state").eq("id", addressId).maybeSingle();
        if (addr) { addressPincode = addr.pincode; addressState = addr.state; }
    }

    // NOTE: window is now purely informational — never gates the quote or
    // the eventual order. It only pushes the delivery estimate out.
    const acceptanceWindow = await getAcceptanceWindow(submissionId);
    const delivery = await estimateDeliveryDate(submission, addressPincode, addressState, acceptanceWindow.delayDays);

    const acceptanceInfo = {
        acceptingNow: acceptanceWindow.open,
        acceptanceMessage: acceptanceWindow.message || null,
        acceptanceDelayDays: acceptanceWindow.delayDays,
        acceptanceWindowLabel: acceptanceWindow.windowLabel || null,
    };

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
            ...acceptanceInfo,
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

    const { exceedsStock, availableStock } = checkStockLimit(submission, saleQty);
    const outOfStock = submission.stock_type === "ready_stock"
        && submission.stock_quantity != null
        && Number(submission.stock_quantity) <= 0;

    res.json({
        success: true,
        orderType: "standard",
        unitPrice, basePriceApplied: slabPrice, appliedSlab, discountPercent, discountTier,
        unit: submission.unit, moq: submission.moq,
        saleUnit: getSaleUnit(submission.units_per_master_pack),
        saleUnitLabel: saleUnitLabel(submission.units_per_master_pack),
        purchaseBasis, quantity: qty, saleUnitQuantity: saleQty,
        estimatedDeliveryDate: delivery.label,
        leadDays: delivery.leadDays,
        transitDaysMin: delivery.transitDaysMin, transitDaysMax: delivery.transitDaysMax,
        availableStock, subtotal,
        platformFeePercent: commissionPercent, platformFeeAmount: platformFee, sellerPayoutAmount: subtotal - platformFee,
        meetsMoq: saleQty >= Number(submission.moq),
        exceedsStock,
        outOfStock,
        ...acceptanceInfo,
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

    // Location serviceability is still a HARD block — a seller who
    // genuinely doesn't ship to this state/city can't fulfill the order.
    // Order-window/hours is NO LONGER checked here as a block — see
    // estimateDeliveryDate below, which is where "seller currently closed"
    // now shows up (as extra days on the estimate) instead.
    const { data: constraintRow } = await supabase
        .from("seller_product_submissions")
        .select("dispatching_locations")
        .eq("id", submissionId)
        .maybeSingle();

    if (constraintRow) {
        const { data: address } = await supabase.from("buyer_addresses").select("state, city").eq("id", shippingAddressId).maybeSingle();
        const locationCheck = checkLocationServiceable(constraintRow.dispatching_locations, address);
        if (!locationCheck.serviceable) {
            return res.status(400).json({ success: false, code: locationCheck.reason, message: locationCheck.message });
        }
    }

    if (safeOrderType !== "sample") {
        const { data: submission } = await supabase
            .from("seller_product_submissions")
            .select("stock_type, stock_quantity, pack_size, units_per_master_pack")
            .eq("id", submissionId)
            .maybeSingle();

        if (submission) {
            if (submission.stock_type === "ready_stock" && Number(submission.stock_quantity) <= 0) {
                return res.status(400).json({ success: false, code: "OUT_OF_STOCK", message: "This item is currently out of stock." });
            }

            const saleQty = purchaseQtyToSaleUnitQty(qty, purchaseBasis, submission.pack_size, submission.units_per_master_pack);
            const { exceedsStock, availableStock } = checkStockLimit(submission, saleQty);
            if (exceedsStock) {
                const label = saleUnitLabel(submission.units_per_master_pack);
                return res.status(400).json({
                    success: false, code: "EXCEEDS_AVAILABLE_STOCK",
                    message: `You can order at most ${availableStock} ${label}${Number(availableStock) === 1 ? "" : "s"} from this seller.`,
                });
            }
        }
    }

    // ---------------------------------------------------------------
    // Authoritative delivery estimate: acceptance delay (server clock,
    // computed fresh here — never trust whatever the client last saw)
    // + lead time + transit, all folded together into one final date
    // range, exactly the same shape the quote screen showed.
    // ---------------------------------------------------------------
    let estDeliveryDateISO = null;
    let estDeliveryDateMaxISO = null;
    let acceptanceDelayDaysUsed = 0;
    {
        const acceptanceWindow = await getAcceptanceWindow(submissionId);
        acceptanceDelayDaysUsed = acceptanceWindow.delayDays;

        const { data: submissionForDelivery } = await supabase
            .from("seller_product_submissions")
            .select("stock_type, production_lead_time_days, dispatch_time_days, lead_time, dispatch_pincode, dispatch_state")
            .eq("id", submissionId)
            .maybeSingle();

        const { data: shippingAddress } = await supabase
            .from("buyer_addresses")
            .select("pincode, state")
            .eq("id", shippingAddressId)
            .maybeSingle();

        if (submissionForDelivery && shippingAddress) {
            try {
                const delivery = await estimateDeliveryDate(submissionForDelivery, shippingAddress.pincode, shippingAddress.state, acceptanceDelayDaysUsed);
                estDeliveryDateISO = delivery.dateMin.toISOString().slice(0, 10);
                estDeliveryDateMaxISO = delivery.dateMax.toISOString().slice(0, 10);
            } catch (err) {
                console.error("estimateDeliveryDate failed during placeOrder:", err?.message || err);
            }
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
        p_estimated_delivery_date: estDeliveryDateISO,
        p_estimated_delivery_date_max: estDeliveryDateMaxISO,
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

    // WhatsApp acknowledgement to the buyer — sent regardless of whether
    // the order lands straight in awaiting_payment or is already
    // confirmed, so a buyer who isn't in the app right now still knows
    // it went through. Best-effort: failures here never affect the API
    // response below.
    {
        const { data: buyerProfile } = await supabase
            .from("profiles").select("name, phone").eq("id", buyerId).maybeSingle();
        if (buyerProfile?.phone) {
            await sendOrderUpdateWhatsApp({
                to: buyerProfile.phone,
                name: buyerProfile.name,
                headline: `Your order #${row.order_number} has been placed successfully.`,
                detail: row.order_status === "awaiting_payment"
                    ? "Please complete your payment to confirm this order."
                    : `Estimated delivery: ${row.estimated_delivery_date || "will be shared soon"}.`,
                footer: "Track your order anytime in the app.",
            });
        }
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

            await supabase.rpc("wallet_accrue_commission", { p_order_id: row.order_id });

            // Commission was JUST accrued above — check right now whether
            // that push tipped this seller's wallet over the blocking
            // threshold. Node never computes the balance itself, so this
            // re-read is the only way to know.
            if (sellerProfile) {
                await notifyIfWalletJustBlocked({ sellerId: submission.seller_id, sellerUserId: sellerProfile.user_id });
            }
        }
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
        // row.notify_user_id here is the SELLER's user id (the buyer
        // cancelled, seller gets told) — reuse it for the wallet re-check,
        // since reversing commission can pull a seller back under the
        // blocking threshold.
        const { data: orderForWallet } = await supabase
            .from("orders").select("seller_id").eq("id", req.params.id).maybeSingle();
        if (orderForWallet?.seller_id) {
            await notifyIfWalletJustBlocked({ sellerId: orderForWallet.seller_id, sellerUserId: row.notify_user_id });
        }

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


// GET /api/orders/order-constraints?submissionId=...
// Powers BuyNowModal's instant "seller not accepting orders right now" /
// "not deliverable to your address" checks. placeOrder() below re-checks
// both with the server's own clock before actually creating the order —
// this endpoint is only for fast UI feedback, never the source of truth.
export async function getOrderConstraints(req, res) {
    const { submissionId } = req.query;
    if (!submissionId) return res.status(400).json({ success: false, message: "submissionId is required." });

    const { data, error } = await supabase
        .from("seller_product_submissions")
        .select("dispatching_locations, seller:seller_profiles!seller_product_submissions_seller_id_fkey ( working_days, order_acceptance_start, order_acceptance_end, holidays )")
        .eq("id", submissionId)
        .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Listing not available." });

    const windowStatus = checkOrderWindow({
        workingDays: data.seller?.working_days,
        orderAcceptanceStart: data.seller?.order_acceptance_start,
        orderAcceptanceEnd: data.seller?.order_acceptance_end,
        holidays: data.seller?.holidays,
    });

    res.json({
        success: true,
        dispatchingLocations: data.dispatching_locations || [],
        workingDays: data.seller?.working_days || [],
        orderAcceptanceStart: data.seller?.order_acceptance_start || null,
        orderAcceptanceEnd: data.seller?.order_acceptance_end || null,
        holidays: data.seller?.holidays || [],
        // pre-computed so the frontend doesn't need to reimplement the
        // "next open day" scan just to render the notice
        acceptingNow: windowStatus.open,
        acceptanceDelayDays: windowStatus.delayDays,
        acceptanceMessage: windowStatus.message || null,
    });
}