// controllers/orders.controller.js
import { supabase } from "../config/supabase.js";
import { notifyUser, notifyOrderChanged, notifyUserOrdersChanged } from "../services/realtimeBroadcast.js";
import { sendOrderUpdateWhatsApp } from "../services/whatsapp.service.js";
import { notifyIfWalletJustBlocked } from "../services/walletNotifications.service.js";
import { fetchCustomPriceMap, resolveEffectiveBasePrice } from "../../shared/customPricing.js";

import { getRoadDistanceKm } from "../services/pincodeDistance.js";
import { purchaseQtyToSaleUnitQty, saleUnitQtyToBaseUnits, getSaleUnit, saleUnitLabel, round2 } from "../../shared/packUnits.js";

import { checkOrderWindow, checkLocationServiceable } from "../../shared/orderConstraints.js";
import { TRANSPORT_OPTIONS } from "../../shared/transportOptions.js"; // NEW


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
    INVALID_TRANSPORT_OPTION: { status: 400, message: "That transport option is no longer valid — please pick another." },
    BUYER_NOT_VERIFIED: { status: 403, message: "Please verify your email or phone before placing an order." },
    ADDRESS_NOT_FOUND: { status: 400, message: "Please select a valid shipping address." },
    INVALID_QUANTITY: { status: 400, message: "Please enter a valid quantity." },
    OUT_OF_STOCK: { status: 400, message: "This item is currently out of stock." },
    CREDIT_LIMIT_EXCEEDED: { status: 400, message: "This order exceeds what's currently available on credit with this seller. Try a smaller order, pay another way, or ask the seller to reconsider your credit." },
    CREDIT_LIMIT_REQUIRED: { status: 400, message: "A credit limit is required to approve this request." },
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

// NEW: dispatch location moved from seller_product_submissions to
// seller_profiles a while back (seller_product_submissions.dispatch_pincode/
// dispatch_state are legacy columns that are no longer written to — that's
// why they read as null on every listing, not just some). The seller's
// actual dispatch location now lives on seller_profiles: either their
// registered pincode/state (when dispatch_same_as_registered is true) or
// their explicit dispatch_pincode/dispatch_district/dispatch_state.
function resolveSellerDispatchLocation(seller) {
    if (!seller) return { pincode: null, state: null };
    if (seller.dispatch_same_as_registered) {
        return { pincode: seller.pincode || null, state: seller.state || null };
    }
    // Defensive fallback: if the seller was switched to "custom dispatch
    // location" but never actually filled it in, fall back to their
    // registered address rather than silently returning nothing.
    return {
        pincode: seller.dispatch_pincode || seller.pincode || null,
        state: seller.dispatch_state || seller.state || null,
    };
}

// FIXED: previously this bailed out to a flat 600km the instant EITHER
// pincode was missing, even when both states WERE known — throwing away
// perfectly good same-state/cross-state info. Now it only falls back to
// the fully-generic default when we have no usable geography at all.
function estimateFallbackKm(originPincode, originState, destPincode, destState) {
    if (originPincode && destPincode) {
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

    // One or both pincodes missing — fall back to state-level comparison
    // if we at least have both states.
    if (originState && destState) {
        const sameState = originState.trim().toLowerCase() === destState.trim().toLowerCase();
        return sameState ? 250 : 700;
    }

    // No usable geography at all.
    return 600;
}

// FIXED:
// 1. No longer calls the external getRoadDistanceKm API when either
//    pincode is null — that call can never succeed with a null input,
//    it was just a wasted round trip that always resolved to km=null.
// 2. Logs a single console.warn (with context) only when data is
//    actually missing, instead of unconditionally logging km/origin/dest
//    on every request.
async function estimateTransitDayRange(originPincode, originState, destPincode, destState) {
    const originPrefix3 = originPincode?.slice(0, 3);
    const destPrefix3 = destPincode?.slice(0, 3);
    if (originPrefix3 && originPrefix3 === destPrefix3) return { min: 1, max: 1 };

    if (!originPincode || !destPincode) {
        console.warn("[estimateTransitDayRange] missing pincode(s), using fallback distance", {
            originPincode, originState, destPincode, destState,
        });
        const fallbackKm = estimateFallbackKm(originPincode, originState, destPincode, destState);
        return daysFromDistance(fallbackKm);
    }

    const km = await getRoadDistanceKm(originPincode, destPincode);
    if (km == null) {
        console.warn("[estimateTransitDayRange] getRoadDistanceKm returned null for a complete pincode pair", {
            originPincode, destPincode,
        });
        const fallbackKm = estimateFallbackKm(originPincode, originState, destPincode, destState);
        return daysFromDistance(fallbackKm);
    }

    return daysFromDistance(km);
}

// CHANGED: dispatchPincode/dispatchState are now passed in explicitly,
// already resolved (by the caller) via resolveSellerDispatchLocation from
// seller_profiles — submission.dispatch_pincode/dispatch_state are legacy
// and no longer used as a source.
async function estimateDeliveryDate(submission, dispatchPincode, dispatchState, buyerPincode, buyerState, acceptanceDelayDays = 0) {
    const leadDays = submission.stock_type === "made_to_order"
        ? Number(submission.production_lead_time_days || 0)
        : Number(submission.dispatch_time_days ?? submission.lead_time ?? 0);

    // NEW: surface *why* a distance estimate might be degraded. If this
    // fires, the seller genuinely has no pincode anywhere on their profile
    // (neither dispatch nor registered) — a real seller-profile gap, not a
    // per-request glitch.
    if (!dispatchPincode) {
        console.warn("[estimateDeliveryDate] seller has no resolvable dispatch pincode (checked seller_profiles dispatch + registered pincode)", {
            submissionId: submission.id || null,
        });
    }
    if (!buyerPincode) {
        console.warn("[estimateDeliveryDate] no buyer/destination pincode available", {
            submissionId: submission.id || null,
        });
    }

    const { min: transitMin, max: transitMax } = await estimateTransitDayRange(
        dispatchPincode,
        dispatchState,
        buyerPincode,
        buyerState
    );

    const totalMin = acceptanceDelayDays + leadDays + transitMin;
    const totalMax = acceptanceDelayDays + leadDays + transitMax;

    const dateMin = new Date();
    dateMin.setDate(dateMin.getDate() + totalMin);
    const dateMax = new Date();
    dateMax.setDate(dateMax.getDate() + totalMax);

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

// CHANGED: was 6 sequential round trips (seller lookup, wallet check,
// submission fetch, address fetch, acceptance-window fetch — which
// re-queried the SAME seller_profiles row the wallet check and submission
// fetch already touched — then delivery estimate, then commission RPC).
// Restructured into: one combined submission+seller select (was two
// separate reads of overlapping data), then everything else that doesn't
// depend on submission's own fields fires in parallel via Promise.all.
export async function getOrderQuote(req, res) {
    const { submissionId, quantity, purchaseBasis = "per_pack", orderType = "standard", addressId, destPincode, destState } = req.query;
    const qty = Number(quantity);
    if (!submissionId) return res.status(400).json({ success: false, message: "submissionId is required." });
    if (!(qty > 0)) return res.status(400).json({ success: false, message: "Enter a valid quantity." });

    const isSample = orderType === "sample";
    const allowedBases = isSample ? ["per_unit", "per_pack", "per_master_pack"] : ["per_pack", "per_master_pack"];
    if (!allowedBases.includes(purchaseBasis)) {
        return res.status(400).json({ success: false, message: "Invalid purchase basis." });
    }

    // Single combined fetch — submission fields + the seller fields
    // getAcceptanceWindow used to fetch in a SEPARATE second query.
    const { data: submission, error } = await supabase
        .from("seller_product_submissions")
        .select(`
            id, price, moq, unit, lead_time, stock_quantity, review_status, price_slabs, quantity_discounts,
            stock_type, dispatch_time_days, production_lead_time_days, pack_size, units_per_master_pack,
            sample_available, sample_quantity, sample_price, generic_product_brand_id,
            marketing_commission_percent,
            seller_id,
            seller:seller_profiles!seller_product_submissions_seller_id_fkey (
                working_days, order_acceptance_start, order_acceptance_end, holidays,
                pincode, state, dispatch_pincode, dispatch_state, dispatch_same_as_registered
            )
        `)
        .eq("id", submissionId).maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!submission || submission.review_status !== "approved") {
        return res.status(404).json({ success: false, message: "Listing not available." });
    }

    const customPriceMap = req.user?.id
        ? await fetchCustomPriceMap(supabase, req.user.id, [submission.id])
        : new Map();
    const customOverride = customPriceMap.get(submission.id) || null;

    // Everything below is independent of everything else below it —
    // run it all at once instead of one-after-another.
    let blockMsg, addressResult, commissionResult;
    try {
        [blockMsg, addressResult, commissionResult] = await Promise.all([
            assertSellerAcceptingOrders(submission.seller_id),
            addressId
                ? supabase.from("buyer_addresses").select("pincode, state").eq("id", addressId).maybeSingle()
                : Promise.resolve({ data: null }),
            supabase.rpc("resolve_commission_percent", { p_generic_product_brand_id: submission.generic_product_brand_id }),
        ]);
    } catch (err) {
        console.error("getOrderQuote parallel fetch failed:", err?.message || err);
        return res.status(500).json({ success: false, message: "Couldn't calculate a quote right now. Please try again." });
    }

    if (blockMsg) return res.status(403).json({ success: false, code: "SELLER_BLOCKED", message: blockMsg });

    // NEW: addressId was provided but the row had no pincode saved on it —
    // that's worth knowing about separately from "no address given at all".
    if (addressId && !addressResult.data?.pincode) {
        console.warn("[getOrderQuote] buyer_addresses row has no pincode", {
            submissionId: submission.id,
            addressId,
            addressRowFound: !!addressResult.data,
            addressRowPincode: addressResult.data?.pincode ?? null,
            addressRowState: addressResult.data?.state ?? null,
            queryDestPincode: destPincode ?? null,
            queryDestState: destState ?? null,
        });
    }
    if (!addressId && !destPincode) {
        console.warn("[getOrderQuote] no addressId and no destPincode query param provided at all", {
            submissionId: submission.id,
        });
    }

    const addressPincode = addressResult.data?.pincode || destPincode || null;
    const addressState = addressResult.data?.state || destState || null;

    const commissionPercent = submission.marketing_commission_percent != null
        ? Number(submission.marketing_commission_percent)
        : Number(commissionResult.data ?? 0.25); // legacy fallback — pre-migration listing, never edited since

    const saleQty = purchaseQtyToSaleUnitQty(qty, purchaseBasis, submission.pack_size, submission.units_per_master_pack);
    const baseQty = saleUnitQtyToBaseUnits(saleQty, submission.pack_size, submission.units_per_master_pack);

    // Computed locally from the fields already fetched above — no extra query.
    const acceptanceWindow = checkOrderWindow({
        workingDays: submission.seller?.working_days,
        orderAcceptanceStart: submission.seller?.order_acceptance_start,
        orderAcceptanceEnd: submission.seller?.order_acceptance_end,
        holidays: submission.seller?.holidays,
    });

    const dispatchLocation = resolveSellerDispatchLocation(submission.seller);

    let delivery;
    try {
        delivery = await estimateDeliveryDate(submission, dispatchLocation.pincode, dispatchLocation.state, addressPincode, addressState, acceptanceWindow.delayDays);
    } catch (err) {
        console.error("estimateDeliveryDate failed in getOrderQuote:", err?.message || err);
        return res.status(500).json({ success: false, message: "Couldn't calculate delivery estimate right now." });
    }

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

    let slabPrice, appliedSlab, discountPercent, discountTier;
    if (customOverride) {
        slabPrice = resolveEffectiveBasePrice(pricePerSaleUnit, customOverride);
        appliedSlab = null;
        discountPercent = 0;
        discountTier = null;
    } else {
        ({ price: slabPrice, slab: appliedSlab } = resolveSlabUnitPrice(submission.price_slabs, saleQty, pricePerSaleUnit));
        ({ percent: discountPercent, tier: discountTier } = resolveDiscountPercent(submission.quantity_discounts, saleQty));
    }
    const unitPrice = round2(slabPrice * (1 - discountPercent / 100));

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
        isCustomPriced: !!customOverride,
        outOfStock,
        ...acceptanceInfo,
    });
}

// GET /api/orders/transport-options?submissionId=...
// NEW — lets BuyNowModal fetch exactly the channels THIS seller services,
// without needing the seller's full profile.
export async function getSellerTransportOptions(req, res) {
    const { submissionId } = req.query;
    if (!submissionId) return res.status(400).json({ success: false, message: "submissionId is required." });

    const { data: sub } = await supabase.from("seller_product_submissions").select("seller_id").eq("id", submissionId).maybeSingle();
    if (!sub) return res.status(404).json({ success: false, message: "Listing not available." });

    const { data: seller } = await supabase.from("seller_profiles").select("transport_options").eq("id", sub.seller_id).maybeSingle();
    const keys = Array.isArray(seller?.transport_options) ? seller.transport_options : [];
    const options = TRANSPORT_OPTIONS.filter((t) => keys.includes(t.key)).map((t) => ({ key: t.key, label: t.label }));

    res.json({ success: true, transportOptions: options });
}

// POST /api/orders
export async function placeOrder(req, res) {
    const buyerId = req.user.id;
    // in placeOrder's req.body destructuring, add:
    const {
        submissionId, quantity, purchaseBasis = "per_unit", orderType = "standard",
        sampleOrderId, shippingAddressId, notes,
        transportMode, transportRouteOptionId, // transportRouteOptionId is NEW
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

    // NEW — a buyer can only "request" a channel the seller actually offers.
    let safeTransportMode = null;
    if (transportMode) {
        if (!TRANSPORT_OPTIONS.some((t) => t.key === transportMode)) {
            return res.status(400).json({ success: false, message: "Unrecognised transport method." });
        }
        const { data: sellerProfile } = await supabase
            .from("seller_profiles").select("transport_options")
            .eq("id", sellerRow?.seller_id)
            .maybeSingle();
        const allowed = Array.isArray(sellerProfile?.transport_options) ? sellerProfile.transport_options : [];
        if (!allowed.includes(transportMode)) {
            return res.status(400).json({ success: false, message: "That transport method isn't offered by this seller." });
        }
        safeTransportMode = transportMode;
    }

    const { data: constraintRow } = await supabase
        .from("seller_product_submissions")
        .select("dispatching_locations")
        .eq("id", submissionId)
        .maybeSingle();

    if (constraintRow) {
        const { data: address } = await supabase.from("buyer_addresses").select("state, city").eq("id", shippingAddressId).maybeSingle();
        const locationCheck = checkLocationServiceable(constraintRow.dispatching_locations, address);
        // const locationCheck = checkLocationServiceable(dispatchingLocations, { state: geo.state, city: geo.district });
        // console.log("[deliverability check]", { pincode, resolvedState: geo.state, resolvedDistrict: geo.district, result: locationCheck });
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

    let estDeliveryDateISO = null;
    let estDeliveryDateMaxISO = null;
    let acceptanceDelayDaysUsed = 0;
    {
        const acceptanceWindow = await getAcceptanceWindow(submissionId);
        acceptanceDelayDaysUsed = acceptanceWindow.delayDays;

        const { data: submissionForDelivery } = await supabase
            .from("seller_product_submissions")
            .select(`
                stock_type, production_lead_time_days, dispatch_time_days, lead_time,
                seller:seller_profiles!seller_product_submissions_seller_id_fkey (
                    pincode, state, dispatch_pincode, dispatch_state, dispatch_same_as_registered
                )
            `)
            .eq("id", submissionId)
            .maybeSingle();

        const { data: shippingAddress } = await supabase
            .from("buyer_addresses")
            .select("pincode, state")
            .eq("id", shippingAddressId)
            .maybeSingle();

        if (submissionForDelivery && shippingAddress) {
            try {
                const dispatchLocation = resolveSellerDispatchLocation(submissionForDelivery.seller);
                console.log("[placeOrder] delivery estimate inputs", {
                    submissionId,
                    shippingAddressId,
                    dispatchPincode: dispatchLocation.pincode,
                    dispatchState: dispatchLocation.state,
                    buyerPincode: shippingAddress.pincode,
                    buyerState: shippingAddress.state,
                });
                const delivery = await estimateDeliveryDate(submissionForDelivery, dispatchLocation.pincode, dispatchLocation.state, shippingAddress.pincode, shippingAddress.state, acceptanceDelayDaysUsed);
                estDeliveryDateISO = delivery.dateMin.toISOString().slice(0, 10);
                estDeliveryDateMaxISO = delivery.dateMax.toISOString().slice(0, 10);
            } catch (err) {
                console.error("estimateDeliveryDate failed during placeOrder:", err?.message || err);
            }
        } else {
            console.warn("[placeOrder] skipped delivery estimate — missing submission or shippingAddress row", {
                submissionId,
                shippingAddressId,
                submissionForDeliveryFound: !!submissionForDelivery,
                shippingAddressFound: !!shippingAddress,
            });
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
        p_transport_route_option_id: transportRouteOptionId || null,
        p_transport_mode: safeTransportMode, // buyer's optional preference only
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
      buyer_transport_mode, transport_mode, transport_fields, transport_notes, transport_proof_url, transport_confirmed_at, transport_source,
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
// NEW (PO document pass): nest the seller's GSTIN (business_profiles.gstin,
// via seller_profiles.business_profile_id) under `seller` so the Purchase
// Order document can print it. If this select throws a foreign-key error,
// your actual FK constraint name differs from the guessed
// "seller_profiles_business_profile_id_fkey" (Postgres's default
// table_column_fkey pattern, matching how the rest of this codebase names
// them, e.g. seller_product_submissions_seller_id_fkey above) — check
// `\d seller_profiles` in psql or your Supabase schema view and swap in
// the real name.
export async function getMyOrder(req, res) {
    const { data: order, error } = await supabase
        .from("orders")
        .select(`
      *,
      seller:seller_profiles (
        id, display_name, shop_slug, logo_url, city, state,
        business:business_profiles!seller_profiles_business_profile_id_fkey ( gstin )
      ),
      items:order_items ( * )
    `)
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
        acceptingNow: windowStatus.open,
        acceptanceDelayDays: windowStatus.delayDays,
        acceptanceMessage: windowStatus.message || null,
    });
}