// controllers/cart.controller.js
import { supabase } from "../config/supabase.js";
import { purchaseQtyToSaleUnitQty, saleUnitLabel } from "../../shared/packUnits.js";

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

    // cart_list doesn't carry live stock info — enrich each row with the
    // seller's current stock_type/stock_quantity so the buyer sees an
    // up-to-date cap even if it changed after the item was added.
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
    const { shippingAddressId, notes } = req.body || {};

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

    const { data, error } = await supabase.rpc("place_cart_order", {
        p_buyer_id: req.user.id, p_shipping_address_id: shippingAddressId, p_buyer_notes: notes || null,
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
    res.json({ success: true, proofId: data });
}