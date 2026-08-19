// controllers/sellerOrders.controller.js — UPDATED
//
// Only change: SELECT columns now include order_type, sample_order_id,
// stock_shortfall (orders) and purchase_basis, pack_quantity_snapshot
// (order_items), so SalesOrdersPage can render pack quantities and sample
// badges. Transition handlers are unchanged.
import { supabase } from "../config/supabase.js";
import { notifyOrderChanged, notifyUser, notifyUserOrdersChanged } from "../services/realtimeBroadcast.js";

// GET /api/seller/orders
export async function listSellerOrders(req, res) {
    const { status, orderType } = req.query;
    let query = supabase
        .from("orders")
        .select(`
      id, order_number, status, order_type, sample_order_id, stock_shortfall,
      subtotal_amount, platform_fee_percent, platform_fee_amount, seller_payout_amount, total_amount,
      payment_status, buyer_contact_name, buyer_contact_phone, buyer_contact_email,
      buyer_gstin, buyer_business_name, buyer_gst_verified,
      shipping_address_snapshot, buyer_notes, created_at, updated_at,
      items:order_items ( id, product_name_snapshot, brand_name_snapshot, image_snapshot, unit_price, unit, quantity, purchase_basis, pack_quantity_snapshot, lead_time_snapshot, line_total )
    `)
        .eq("seller_id", req.sellerId).order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    if (orderType) query = query.eq("order_type", orderType);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, orders: data || [] });
}

// GET /api/seller/orders/:id
export async function getSellerOrder(req, res) {
    const { data: order, error } = await supabase
        .from("orders").select("*, items:order_items ( * )")
        .eq("id", req.params.id).eq("seller_id", req.sellerId).maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });

    const { data: events } = await supabase.from("order_events").select("*").eq("order_id", order.id).order("created_at");
    res.json({ success: true, order, events: events || [] });
}

function transitionHandler(newStatus) {
    return async function (req, res) {
        const { reason } = req.body || {};
        const { error } = await supabase.rpc("update_order_status", {
            p_order_id: req.params.id, p_actor_role: "seller", p_actor_user_id: req.user.id,
            p_new_status: newStatus, p_note: reason || null,
        });
        if (error) {
            const status = { FORBIDDEN: 403, ORDER_NOT_FOUND: 404, INVALID_TRANSITION: 400 }[error.message] || 500;
            return res.status(status).json({ success: false, code: error.message, message: status === 400 ? "That status change isn't allowed right now." : "Couldn't update the order." });
        }

        await notifyOrderChanged(req.params.id, { status: newStatus });
        const { data: order } = await supabase.from("orders").select("buyer_id, order_number").eq("id", req.params.id).maybeSingle();
        if (order) {
            await notifyUser(order.buyer_id, {
                type: "order_status", title: `Order ${order.order_number} ${newStatus.replace("_", " ")}`,
                body: reason || undefined, link: `/orders/${req.params.id}`,
            });
            await notifyUserOrdersChanged(order.buyer_id);
        }
        res.json({ success: true, message: `Order marked as ${newStatus.replace("_", " ")}.` });
    };
}

export const confirmOrder = transitionHandler("confirmed");
export const rejectOrder = transitionHandler("rejected");
export const processOrder = transitionHandler("processing");
export const shipOrder = transitionHandler("shipped");
export const deliverOrder = transitionHandler("delivered");