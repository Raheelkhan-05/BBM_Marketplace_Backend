// controllers/cart.controller.js
import { supabase } from "../config/supabase.js";

export async function getCart(req, res) {
    const { data, error } = await supabase.rpc("cart_list", { p_buyer_id: req.user.id });
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

export async function addCartItem(req, res) {
    const { submissionId, quantity, purchaseBasis } = req.body || {};
    const { error } = await supabase.rpc("cart_add_item", {
        p_buyer_id: req.user.id, p_submission_id: submissionId,
        p_quantity: quantity, p_purchase_basis: purchaseBasis || "per_pack",
    });
    if (error) {
        const map = { CANNOT_CART_OWN_LISTING: 400, LISTING_NOT_AVAILABLE: 404, INVALID_QUANTITY: 400, BELOW_MOQ: 400 };
        const message = error.message === "BELOW_MOQ" ? "Quantity is below the seller's minimum order quantity." : "Couldn't add to cart.";
        return res.status(map[error.message] || 500).json({ success: false, code: error.message, message });
    }
    res.json({ success: true });
}

export async function updateCartItem(req, res) {
    const { submissionId } = req.params;
    const { quantity, purchaseBasis } = req.body || {};
    const { error } = await supabase.rpc("cart_set_quantity", {
        p_buyer_id: req.user.id, p_submission_id: submissionId,
        p_quantity: quantity, p_purchase_basis: purchaseBasis || null,
    });
    if (error) {
        const map = { BELOW_MOQ: 400, CART_ITEM_NOT_FOUND: 404 };
        const message = error.message === "BELOW_MOQ" ? "Quantity is below the seller's minimum order quantity." : "Couldn't update cart.";
        return res.status(map[error.message] || 500).json({ success: false, code: error.message, message });
    }
    res.json({ success: true });
}

export async function removeCartItem(req, res) {
    const { submissionId } = req.params;
    const { error } = await supabase.rpc("cart_remove_item", { p_buyer_id: req.user.id, p_submission_id: submissionId });
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true });
}

export async function checkoutCart(req, res) {
    const { shippingAddressId, notes } = req.body || {};
    // console.log(req.user.id)

    // controllers/cart.controller.js — checkoutCart(), before calling place_cart_order
    const { data: cartItems } = await supabase.rpc("cart_list", { p_buyer_id: req.user.id });
    const sellerIds = [...new Set((cartItems || []).map((i) => i.seller_id))];
    for (const sid of sellerIds) {
        const { data: status } = await supabase.rpc("wallet_get_status", { p_seller_id: sid }).single();
        if (status?.is_blocked) {
            return res.status(403).json({ success: false, code: "SELLER_BLOCKED", message: "One or more sellers in your cart aren't accepting new orders right now. Please remove their items to continue." });
        }
    }

    const { data, error } = await supabase.rpc("place_cart_order", {
        p_buyer_id: req.user.id, p_shipping_address_id: shippingAddressId, p_buyer_notes: notes || null,
    }).single();
    // console.log(data, error)
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

        const map = { CART_EMPTY: 400, BUYER_NOT_VERIFIED: 403, ADDRESS_NOT_FOUND: 404 };
        const code = error.message?.split(":")[0];
        return res.status(map[code] || 400).json({ success: false, code, message: "Couldn't place the order." });
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