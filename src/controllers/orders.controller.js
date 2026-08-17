// controllers/orders.controller.js
import { supabase } from "../config/supabase.js";
import { notifyOrderChanged, notifyUser, notifyUserOrdersChanged } from "../services/realtimeBroadcast.js";

const ERROR_MAP = {
    LISTING_NOT_FOUND: { status: 404, message: "That listing is no longer available." },
    LISTING_NOT_APPROVED: { status: 400, message: "This listing isn't approved for sale." },
    CANNOT_ORDER_OWN_LISTING: { status: 400, message: "You can't place an order on your own listing." },
    BELOW_MOQ: { status: 400, message: "Quantity is below the seller's minimum order quantity." },
    INSUFFICIENT_STOCK: { status: 409, message: "The seller doesn't have enough stock for this quantity." },
    BUYER_NOT_FOUND: { status: 401, message: "Please sign in again." },
    BUYER_NOT_VERIFIED: { status: 403, message: "Please verify your email or phone before placing an order." },
    ADDRESS_NOT_FOUND: { status: 400, message: "Please select a valid shipping address." },
    INVALID_QUANTITY: { status: 400, message: "Please enter a valid quantity." },
};
function mapRpcError(error) {
    return ERROR_MAP[(error?.message || "").trim()] || { status: 500, message: "Couldn't place the order. Please try again." };
}

// ---- Slab / quantity-discount pricing --------------------------------
// Mirrors the exact logic in BuyNowModal.jsx's computeLocalQuote, so the
// buyer never sees the instant estimate and the server-confirmed quote
// disagree once background confirmation lands.
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

// GET /api/orders/checkout-status — optional-auth, mirrors fetchSellerAccessStatus's gating shape
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

// GET /api/orders/quote — read-only, applies the same slab/discount math
// the RPC must enforce at commit time, so the UI can show an accurate
// live total. NOTE: placeOrder's `place_order` RPC needs to apply this
// same resolution server-side when it commits the order — see the
// comment on placeOrder() below.
export async function getOrderQuote(req, res) {
    const { submissionId, quantity } = req.query;
    const qty = Number(quantity);
    if (!submissionId) return res.status(400).json({ success: false, message: "submissionId is required." });
    if (!(qty > 0)) return res.status(400).json({ success: false, message: "Enter a valid quantity." });

    const { data: submission, error } = await supabase
        .from("seller_product_submissions")
        .select("id, price, moq, unit, lead_time, stock_quantity, review_status, price_slabs, quantity_discounts, stock_type, dispatch_time_days, production_lead_time_days")
        .eq("id", submissionId).maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!submission || submission.review_status !== "approved") {
        return res.status(404).json({ success: false, message: "Listing not available." });
    }

    const { price: slabPrice, slab: appliedSlab } = resolveSlabUnitPrice(submission.price_slabs, qty, Number(submission.price));
    const { percent: discountPercent, tier: discountTier } = resolveDiscountPercent(submission.quantity_discounts, qty);
    const unitPrice = Math.round(slabPrice * (1 - discountPercent / 100) * 100) / 100;

    const { data: settings } = await supabase.from("platform_settings").select("commission_percent").eq("id", true).maybeSingle();
    const commissionPercent = Number(settings?.commission_percent ?? 5);
    const subtotal = Math.round(unitPrice * qty * 100) / 100;
    const platformFee = Math.round((subtotal * commissionPercent / 100) * 100) / 100;

    const leadTime = submission.stock_type === "made_to_order"
        ? Number(submission.production_lead_time_days || 0)
        : Number(submission.dispatch_time_days ?? submission.lead_time ?? 0);

    res.json({
        success: true,
        unitPrice, basePriceApplied: slabPrice, appliedSlab, discountPercent, discountTier,
        unit: submission.unit, moq: submission.moq,
        leadTime, availableStock: submission.stock_quantity, quantity: qty, subtotal,
        platformFeePercent: commissionPercent, platformFeeAmount: platformFee, sellerPayoutAmount: subtotal - platformFee,
        meetsMoq: qty >= Number(submission.moq),
        hasEnoughStock: submission.stock_quantity == null || qty <= Number(submission.stock_quantity),
    });
}

// POST /api/orders
//
// ⚠️ PRICING GAP: this still only sends { submissionId, quantity } to
// the `place_order` RPC, which (as far as I can see from this file)
// presumably reads `submission.price` directly to compute order totals
// server-side. That RPC needs to be updated to apply the SAME slab /
// quantity-discount resolution as getOrderQuote() above, or a buyer
// quoted a discounted tiered price here could still be charged the flat
// base price when the order actually commits. I don't have the RPC's
// SQL body, so I can't safely edit it — please share it (or the
// migration that defines it) and I'll wire the matching logic in.
export async function placeOrder(req, res) {
    const buyerId = req.user.id; // identity only ever comes from the verified token
    const { submissionId, quantity, shippingAddressId, notes } = req.body || {};
    if (!submissionId) return res.status(400).json({ success: false, message: "Missing listing." });
    if (!shippingAddressId) return res.status(400).json({ success: false, message: "Please select a shipping address." });
    const qty = Number(quantity);
    if (!(qty > 0)) return res.status(400).json({ success: false, message: "Please enter a valid quantity." });

    const { data, error } = await supabase.rpc("place_order", {
        p_buyer_id: buyerId, p_submission_id: submissionId, p_quantity: qty,
        p_shipping_address_id: shippingAddressId, p_buyer_notes: notes || null,
    });

    if (error) {
        const mapped = mapRpcError(error);

        // Demand signal: this insert is deliberately OUTSIDE the aborted RPC
        // transaction — the order never happened, but the seller still learns
        // a buyer wanted more than what's currently listed.
        if (error.message === "INSUFFICIENT_STOCK") {
            const { data: submission } = await supabase
                .from("seller_product_submissions")
                .select("id, stock_quantity, unit, seller_id")
                .eq("id", submissionId).maybeSingle();
            if (submission) {
                const { data: sellerProfile } = await supabase
                    .from("seller_profiles").select("user_id").eq("id", submission.seller_id).maybeSingle();
                if (sellerProfile) {
                    await notifyUser(sellerProfile.user_id, {
                        type: "stock_demand", title: "A buyer wanted more than your available stock",
                        body: `Requested ${qty} ${submission.unit}, but only ${submission.stock_quantity ?? 0} ${submission.unit} is listed.`,
                        link: "/seller/products",
                    });
                }
            }
        }

        return res.status(mapped.status).json({ success: false, code: error.message, message: mapped.message });
    }

    const row = Array.isArray(data) ? data[0] : data;

    // tell the seller: this was missing entirely before — nothing notified the
    // seller of a new order on the success path.
    const { data: submission } = await supabase.from("seller_product_submissions").select("seller_id").eq("id", submissionId).maybeSingle();
    if (submission) {
        const { data: sellerProfile } = await supabase.from("seller_profiles").select("user_id").eq("id", submission.seller_id).maybeSingle();
        if (sellerProfile) {
            await notifyUser(sellerProfile.user_id, {
                type: "new_order", title: "New order received",
                body: `Order ${row.order_number} was just placed.`, link: `/seller/orders/${row.order_id}`,
            });
            await notifyUserOrdersChanged(sellerProfile.user_id);
        }
    }
    res.json({ success: true, orderId: row.order_id, orderNumber: row.order_number, message: "Order placed. The seller has been notified." });
}

// GET /api/orders
export async function listMyOrders(req, res) {
    const { status } = req.query;
    let query = supabase
        .from("orders")
        .select(`
      id, order_number, status, subtotal_amount, total_amount, payment_status, created_at, updated_at,
      seller:seller_profiles ( id, display_name, shop_slug, logo_url, city, state ),
      items:order_items ( id, product_name_snapshot, brand_name_snapshot, image_snapshot, unit_price, unit, quantity, line_total )
    `)
        .eq("buyer_id", req.user.id).order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);

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

// POST /api/orders/:id/cancel
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
            await notifyUser(sellerProfile.user_id, { type: "order_cancelled", title: `Order ${order.order_number} cancelled`, body: reason || "Cancelled by buyer", link: `/seller/orders/${req.params.id}` });
            await notifyUserOrdersChanged(sellerProfile.user_id);
        }
    }
    if (error) {
        const status = { FORBIDDEN: 403, ORDER_NOT_FOUND: 404, INVALID_TRANSITION: 400 }[error.message] || 500;
        return res.status(status).json({ success: false, code: error.message, message: status === 400 ? "This order can no longer be cancelled." : "Couldn't cancel the order." });
    }
    res.json({ success: true, message: "Order cancelled." });
}