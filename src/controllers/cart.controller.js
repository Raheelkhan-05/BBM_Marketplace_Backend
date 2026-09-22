// controllers/cart.controller.js
import { supabase } from "../config/supabase.js";
import { purchaseQtyToSaleUnitQty, saleUnitLabel } from "../../shared/packUnits.js";
import { checkOrderWindow, checkLocationServiceable } from "../../shared/orderConstraints.js";
import { notifyAdmins, notifyAdminPaymentsChanged } from "../services/notifications.service.js";

// Fetches just enough from seller_product_submissions to validate a
// requested quantity against available stock. Shared by addCartItem,
// updateCartItem, and checkoutCart so all three use the exact same rule.
async function loadStockInfo(submissionId) {
    const { data, error } = await supabase
        .from("seller_product_submissions")
        .select("id, stock_type, stock_quantity, pack_size, units_per_master_pack, brand_item_name:generic_product_brand_id")
        .eq("id", submissionId)
        .maybeSingle();
    if (error || !data) return null;
    return data;
}

// Returns an error message if the requested sale-unit quantity exceeds
// what this seller actually has in stock. Only applies to ready_stock
// listings with a known stock_quantity — made_to_order listings and
// listings with no stock cap set are unaffected (nothing to exceed).
function checkStockLimit(submission, purchaseQty, purchaseBasis) {
    if (!submission) return null;
    if (submission.stock_type !== "ready_stock" || submission.stock_quantity == null) return null;

    const saleQty = purchaseQtyToSaleUnitQty(purchaseQty, purchaseBasis, submission.pack_size, submission.units_per_master_pack);
    const available = Number(submission.stock_quantity);
    if (saleQty <= available) return null;

    const unitLabel = saleUnitLabel(submission.units_per_master_pack);
    if (available <= 0) {
        return `This item is currently out of stock with this seller.`;
    }
    return `Only ${available} ${unitLabel}${available === 1 ? "" : "s"} available from this seller. Please reduce the quantity.`;
}


export async function getCart(req, res) {
    const { data, error } = await supabase.rpc("cart_list", { p_buyer_id: req.user.id });
    if (error) return res.status(500).json({ success: false, message: error.message });

    const items = data || [];

    const submissionIds = [...new Set(items.map((i) => i.submission_id).filter(Boolean))];
    if (submissionIds.length) {
        const { data: stockRows } = await supabase
            .from("seller_product_submissions")
            .select("id, stock_type, stock_quantity")
            .in("id", submissionIds);
        const stockById = new Map((stockRows || []).map((r) => [r.id, r]));
        for (const item of items) {
            const stock = stockById.get(item.submission_id);
            item.stock_type = stock?.stock_type ?? null;
            item.available_stock = stock?.stock_quantity ?? null;
        }
    }

    // NEW: attach each seller's dispatch location + which transport modes
    // they offer, so the cart page can drive the same per-seller
    // "Preferred transport" flow BuyNowModal drives for a single seller
    // (see components/transport/TransportPreferenceModal.jsx, which needs
    // seller.dispatchOrigin / seller.dispatchState / seller.transportOptions).
    // Mirrors resolveSellerDispatchLocation's state-resolution rule from
    // orders.controller.js: dispatch_state when the seller has a distinct
    // dispatch location, otherwise their registered state. There's no
    // separate dispatch-city column anywhere in this schema, so the
    // registered city is used as the origin city in both cases.
    const sellerIds = [...new Set(items.map((i) => i.seller_id).filter(Boolean))];
    if (sellerIds.length) {
        const { data: sellerRows } = await supabase
            .from("seller_profiles")
            .select("id, display_name, city, state, dispatch_state, dispatch_same_as_registered, transport_options")
            .in("id", sellerIds);
        const sellerById = new Map((sellerRows || []).map((r) => [r.id, r]));
        for (const item of items) {
            const seller = sellerById.get(item.seller_id);
            item.seller_dispatch_city = seller?.city || null;
            item.seller_dispatch_state = (seller?.dispatch_same_as_registered === false ? seller?.dispatch_state : seller?.state) || seller?.state || null;
            item.seller_transport_options = Array.isArray(seller?.transport_options) ? seller.transport_options : [];
        }
    }

    res.json({ success: true, items });
}

export async function addCartItem(req, res) {
    const { submissionId, quantity, purchaseBasis } = req.body || {};

    const submission = await loadStockInfo(submissionId);
    const stockError = checkStockLimit(submission, Number(quantity), purchaseBasis || "per_pack");
    if (stockError) {
        return res.status(400).json({ success: false, code: "EXCEEDS_AVAILABLE_STOCK", message: stockError });
    }

    // Any cart edit means the buyer's intent has changed — a previously
    // "awaiting_payment" snapshot no longer reflects what they actually
    // want to buy. Cancel it so checkout recomputes fresh instead of
    // silently resuming a stale total (see place_cart_order's
    // PENDING_GROUP_EXISTS branch, which otherwise just resumes whatever
    // was locked in before this edit).
    await supabase.rpc("cancel_pending_order_group_if_exists", { p_buyer_id: req.user.id });

    const { error } = await supabase.rpc("cart_add_item", {
        p_buyer_id: req.user.id, p_submission_id: submissionId,
        p_quantity: quantity, p_purchase_basis: purchaseBasis || "per_pack",
    });
    if (error) {
        const map = { CANNOT_CART_OWN_LISTING: 400, LISTING_NOT_AVAILABLE: 404, INVALID_QUANTITY: 400, BELOW_MOQ: 400, EXCEEDS_AVAILABLE_STOCK: 400 };
        const message = error.message === "BELOW_MOQ" ? "Quantity is below the seller's minimum order quantity."
            : error.message === "EXCEEDS_AVAILABLE_STOCK" ? "That quantity isn't available from this seller."
                : "Couldn't add to cart.";
        return res.status(map[error.message] || 500).json({ success: false, code: error.message, message });
    }
    res.json({ success: true });
}

export async function updateCartItem(req, res) {
    const { submissionId } = req.params;
    const { quantity, purchaseBasis } = req.body || {};

    if (Number(quantity) > 0) {
        const submission = await loadStockInfo(submissionId);
        const stockError = checkStockLimit(submission, Number(quantity), purchaseBasis || submission?.purchase_basis || "per_pack");
        if (stockError) {
            return res.status(400).json({ success: false, code: "EXCEEDS_AVAILABLE_STOCK", message: stockError });
        }
    }

    await supabase.rpc("cancel_pending_order_group_if_exists", { p_buyer_id: req.user.id });

    const { error } = await supabase.rpc("cart_set_quantity", {
        p_buyer_id: req.user.id, p_submission_id: submissionId,
        p_quantity: quantity, p_purchase_basis: purchaseBasis || null,
    });
    if (error) {
        const map = { BELOW_MOQ: 400, CART_ITEM_NOT_FOUND: 404, EXCEEDS_AVAILABLE_STOCK: 400 };
        const message = error.message === "BELOW_MOQ" ? "Quantity is below the seller's minimum order quantity."
            : error.message === "EXCEEDS_AVAILABLE_STOCK" ? "That quantity isn't available from this seller."
                : "Couldn't update cart.";
        return res.status(map[error.message] || 500).json({ success: false, code: error.message, message });
    }
    res.json({ success: true });
}

export async function removeCartItem(req, res) {
    const { submissionId } = req.params;

    await supabase.rpc("cancel_pending_order_group_if_exists", { p_buyer_id: req.user.id });

    const { error } = await supabase.rpc("cart_remove_item", { p_buyer_id: req.user.id, p_submission_id: submissionId });
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true });
}

export async function checkoutCart(req, res) {
    const { shippingAddressId, notes, transportPreferences } = req.body || {};

    const { data: cartItems } = await supabase.rpc("cart_list", { p_buyer_id: req.user.id });
    const sellerIds = [...new Set((cartItems || []).map((i) => i.seller_id))];
    for (const sid of sellerIds) {
        const { data: status } = await supabase.rpc("wallet_get_status", { p_seller_id: sid }).single();
        if (status?.is_blocked) {
            return res.status(403).json({ success: false, code: "SELLER_BLOCKED", message: "One or more sellers in your cart aren't accepting new orders right now. Please remove their items to continue." });
        }
    }

    // Defense in depth: re-validate every line against LIVE stock right
    // before placing the order. Quantities were checked when added/edited,
    // but stock can move (another buyer, seller adjustment) between then
    // and checkout, and place_cart_order itself may not enforce this yet.
    const submissionIds = [...new Set((cartItems || []).map((i) => i.submission_id).filter(Boolean))];
    if (submissionIds.length) {
        const { data: stockRows } = await supabase
            .from("seller_product_submissions")
            .select("id, stock_type, stock_quantity, pack_size, units_per_master_pack")
            .in("id", submissionIds);
        const stockById = new Map((stockRows || []).map((r) => [r.id, r]));
        for (const item of cartItems || []) {
            const submission = stockById.get(item.submission_id);
            const stockError = checkStockLimit(submission, Number(item.quantity), item.purchase_basis || "per_pack");
            if (stockError) {
                return res.status(400).json({
                    success: false, code: "EXCEEDS_AVAILABLE_STOCK",
                    message: `${item.product_name || "One item"} in your cart: ${stockError}`,
                });
            }
        }
    }

    // Same order-window + serviceability re-check as placeOrder(), just
    // applied per seller (window) and per item (location) since a cart
    // can span multiple sellers.
    const uniqueSellerIds = [...new Set((cartItems || []).map((i) => i.seller_id))];
    if (uniqueSellerIds.length) {
        const { data: sellerProfiles } = await supabase
            .from("seller_profiles")
            .select("id, working_days, order_acceptance_start, order_acceptance_end, holidays")
            .in("id", uniqueSellerIds);
        const profileById = new Map((sellerProfiles || []).map((p) => [p.id, p]));

    }

    if (submissionIds.length) {
        const { data: address } = await supabase.from("buyer_addresses").select("state, city").eq("id", shippingAddressId).maybeSingle();
        const { data: locationRows } = await supabase
            .from("seller_product_submissions")
            .select("id, dispatching_locations")
            .in("id", submissionIds);
        const locationById = new Map((locationRows || []).map((r) => [r.id, r.dispatching_locations]));
        for (const item of cartItems || []) {
            const locationCheck = checkLocationServiceable(locationById.get(item.submission_id), address);
            if (!locationCheck.serviceable) {
                return res.status(400).json({
                    success: false, code: locationCheck.reason,
                    message: `${item.product_name || "One item"} in your cart: ${locationCheck.message}`,
                });
            }
        }
    }

    // NEW: validate any per-seller transport preferences the buyer chose
    // in the cart UI — exactly the same rule placeOrder() applies for a
    // single seller: a buyer can only lock in a route option that seller
    // actually has approved. Invalid entries fail the whole checkout
    // rather than silently falling back to "no preference", so the buyer
    // isn't surprised later by a transport choice they didn't actually
    // get.
    let transportBySeller = {};
    if (Array.isArray(transportPreferences) && transportPreferences.length) {
        const routeOptionIds = transportPreferences.map((t) => t?.routeOptionId).filter(Boolean);
        const { data: routeRows } = routeOptionIds.length
            ? await supabase
                .from("transport_route_options")
                .select("id, seller_id, mode, fields, status")
                .in("id", routeOptionIds)
            : { data: [] };
        const routeById = new Map((routeRows || []).map((r) => [r.id, r]));

        for (const pref of transportPreferences) {
            if (!pref?.routeOptionId || !pref?.sellerId) continue;
            const route = routeById.get(pref.routeOptionId);
            if (!route || route.seller_id !== pref.sellerId || route.status !== "approved") {
                return res.status(400).json({
                    success: false, code: "INVALID_TRANSPORT_OPTION",
                    message: "One of your selected transport options is no longer valid — please pick another.",
                });
            }
            transportBySeller[pref.sellerId] = {
                route_option_id: route.id,
                mode: route.mode,
                fields: route.fields,
                source: "buyer_selected_approved",
            };
        }
    }

    const { data, error } = await supabase.rpc("place_cart_order", {
        p_buyer_id: req.user.id, p_shipping_address_id: shippingAddressId, p_buyer_notes: notes || null,
        p_transport_preferences: transportBySeller,
    }).single();

    if (error) {
        const codes = (error.message || "").trim();

        if (codes === "PENDING_GROUP_EXISTS") {
            const { data: pending, error: lookupError } = await supabase
                .from("order_groups")
                .select("id, group_number, total_amount")
                .eq("buyer_id", req.user.id)
                .eq("payment_status", "pending")
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (lookupError || !pending) {
                return res.status(500).json({ success: false, message: "Couldn't resume your pending payment. Please try again." });
            }

            return res.json({
                success: true,
                resumed: true, // frontend can use this to skip a "order placed" toast if you show one
                orderGroupId: pending.id,
                groupNumber: pending.group_number,
                totalAmount: pending.total_amount,
            });
        }

        const map = { CART_EMPTY: 400, BUYER_NOT_VERIFIED: 403, ADDRESS_NOT_FOUND: 404, EXCEEDS_AVAILABLE_STOCK: 400 };
        const code = error.message?.split(":")[0];
        const message = code === "EXCEEDS_AVAILABLE_STOCK" ? "One or more items exceed the seller's available stock." : "Couldn't place the order.";
        return res.status(map[code] || 400).json({ success: false, code, message });
    }
    res.json({
        success: true,
        orderGroupId: data.order_group_id,
        groupNumber: data.group_number,
        totalAmount: data.total_amount,
        sellerOrderCount: data.seller_order_count,
    });
}

export async function submitGroupPaymentProof(req, res) {
    const { groupId } = req.params;
    const { utr, screenshotUrl } = req.body || {};
    const { data, error } = await supabase.rpc("submit_group_payment_proof", {
        p_group_id: groupId, p_buyer_id: req.user.id, p_utr: utr, p_screenshot_url: screenshotUrl,
    });
    if (error) return res.status(400).json({ success: false, code: error.message, message: "Couldn't submit payment proof." });

    const { data: groupRow } = await supabase
        .from("order_groups")
        .select("group_number")
        .eq("id", groupId)
        .maybeSingle();

    await notifyAdmins({
        type: "payment_proof_submitted",
        title: `Payment proof submitted: Group ${groupRow?.group_number || groupId}`,
        body: "Buyer submitted a payment reference covering this cart's orders — needs review.",
        link: `/payments?queue=orders&status=pending&highlight=${data}`,
    });
    await notifyAdminPaymentsChanged();

    res.json({ success: true, proofId: data });
}