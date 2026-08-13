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

// GET /api/orders/quote — read-only, same math the RPC enforces, so the UI can show an accurate total live
export async function getOrderQuote(req, res) {
    const { submissionId, quantity } = req.query;
    const qty = Number(quantity);
    if (!submissionId) return res.status(400).json({ success: false, message: "submissionId is required." });
    if (!(qty > 0)) return res.status(400).json({ success: false, message: "Enter a valid quantity." });

    const { data: submission, error } = await supabase
        .from("seller_product_submissions")
        .select("id, price, moq, unit, lead_time, stock_quantity, review_status")
        .eq("id", submissionId).maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!submission || submission.review_status !== "approved") {
        return res.status(404).json({ success: false, message: "Listing not available." });
    }

    const { data: settings } = await supabase.from("platform_settings").select("commission_percent").eq("id", true).maybeSingle();
    const commissionPercent = Number(settings?.commission_percent ?? 5);
    const subtotal = Math.round(submission.price * qty * 100) / 100;
    const platformFee = Math.round((subtotal * commissionPercent / 100) * 100) / 100;

    res.json({
        success: true, unitPrice: submission.price, unit: submission.unit, moq: submission.moq,
        leadTime: submission.lead_time, availableStock: submission.stock_quantity, quantity: qty, subtotal,
        platformFeePercent: commissionPercent, platformFeeAmount: platformFee, sellerPayoutAmount: subtotal - platformFee,
        meetsMoq: qty >= Number(submission.moq),
        hasEnoughStock: submission.stock_quantity == null || qty <= Number(submission.stock_quantity),
    });
}

// POST /api/orders
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