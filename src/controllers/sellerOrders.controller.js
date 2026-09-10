// controllers/sellerOrders.controller.js
//
// transitionHandler no longer calls notifyUser(...) a second time for the
// same status change — update_order_status already inserts the buyer-facing
// notification row itself. notifyOrderChanged/notifyUserOrdersChanged are
// KEPT: both are realtime channel broadcasts, not notifications-table rows.
//
// NEW: every transition now also sends a WhatsApp update to the buyer
// (confirmed/rejected/processing/shipped/delivered all fall out of this
// same handler), and the "rejected" transition re-checks the seller's
// wallet after reversing commission, since a reversal can pull them back
// under the blocking threshold.
import { supabase } from "../config/supabase.js";
import { notifyOrderChanged, notifyUserOrdersChanged, notifyUser } from "../services/realtimeBroadcast.js";
import { sendOrderUpdateWhatsApp } from "../services/whatsapp.service.js";
import { notifyIfWalletJustBlocked } from "../services/walletNotifications.service.js";

function whatsappHeadlineForStatus(newStatus, orderNumber) {
    const map = {
        confirmed: `Your order #${orderNumber} has been confirmed by the seller.`,
        rejected: `Your order #${orderNumber} was rejected by the seller.`,
        processing: `Your order #${orderNumber} is now being processed.`,
        shipped: `Your order #${orderNumber} has been shipped.`,
        delivered: `Your order #${orderNumber} has been delivered.`,
    };
    return map[newStatus] || `Your order #${orderNumber} status changed to ${newStatus.replace("_", " ")}.`;
}

// GET /api/seller/orders
export async function listSellerOrders(req, res) {
    const { status, orderType } = req.query;
    let query = supabase
        .from("orders")
        .select(`
      id, order_number, status, order_type, sample_order_id, stock_shortfall,
      order_group_id,
      order_group:order_groups ( group_number ),
      subtotal_amount, platform_fee_percent, platform_fee_amount, seller_payout_amount, total_amount,
      payment_status, buyer_contact_name, buyer_contact_phone, buyer_contact_email,
      buyer_gstin, buyer_business_name, buyer_gst_verified,
      shipping_address_snapshot, buyer_notes, created_at, updated_at,
      transport_mode, transport_company, transport_details, transport_source,
      items:order_items ( id, product_name_snapshot, brand_name_snapshot, image_snapshot, unit_price, base_price_applied, discount_percent, unit, quantity, purchase_basis, pack_quantity_snapshot, lead_time_snapshot, line_total )
    `)
        .eq("seller_id", req.sellerId).neq("status", "awaiting_payment").order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    if (orderType) query = query.eq("order_type", orderType);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    const orders = (data || []).map((o) => ({ ...o, group_number: o.order_group?.group_number || null }));
    res.json({ success: true, orders });
}

// GET /api/seller/orders/:id
export async function getSellerOrder(req, res) {
    const { data: order, error } = await supabase
        .from("orders").select("*, items:order_items ( * )")
        .eq("id", req.params.id).eq("seller_id", req.sellerId).neq("status", "awaiting_payment").maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });

    const { data: events } = await supabase.from("order_events").select("*").eq("order_id", order.id).order("created_at");
    res.json({ success: true, order, events: events || [] });
}

function transitionHandler(newStatus) {
    return async function (req, res) {
        const { reason } = req.body || {};
        const { data, error } = await supabase.rpc("update_order_status", {
            p_order_id: req.params.id, p_actor_role: "seller", p_actor_user_id: req.user.id,
            p_new_status: newStatus, p_note: reason || null,
        });
        if (error) {
            const status = { FORBIDDEN: 403, ORDER_NOT_FOUND: 404, INVALID_TRANSITION: 400 }[error.message] || 500;
            return res.status(status).json({ success: false, code: error.message, message: status === 400 ? "That status change isn't allowed right now." : "Couldn't update the order." });
        }

        if (newStatus === "rejected") {
            await supabase.rpc("wallet_reverse_commission", { p_order_id: req.params.id });

            // Reversing commission can pull a seller back UNDER the
            // threshold — re-check so the blocked flag clears (and the
            // seller is told, on the next block cycle) the moment that
            // happens, not just on their next top-up.
            const { data: orderForWallet } = await supabase
                .from("orders").select("seller_id").eq("id", req.params.id).maybeSingle();
            if (orderForWallet?.seller_id) {
                await notifyIfWalletJustBlocked({ sellerId: orderForWallet.seller_id, sellerUserId: req.sellerId });
            }
        }

        const row = Array.isArray(data) ? data[0] : data;

        await notifyOrderChanged(req.params.id, { status: newStatus });
        if (row?.notify_user_id) {
            await notifyUser(row.notify_user_id, {
                type: `order_status_${newStatus}`,
                title: `Order ${row.order_number} ${newStatus.replace("_", " ")}`,
                body: reason || `Your order status was updated to ${newStatus.replace("_", " ")}.`,
                link: `/orders/${req.params.id}`,
            });
            await notifyUserOrdersChanged(row.notify_user_id);

            // WhatsApp fallback for buyers not currently in the app —
            // covers confirmed/rejected/processing/shipped/delivered, all
            // through this one handler. Best-effort, never blocks the
            // response below.
            const { data: orderRow } = await supabase
                .from("orders")
                .select("buyer_contact_name, buyer_contact_phone")
                .eq("id", req.params.id)
                .maybeSingle();
            if (orderRow?.buyer_contact_phone) {
                await sendOrderUpdateWhatsApp({
                    to: orderRow.buyer_contact_phone,
                    name: orderRow.buyer_contact_name,
                    headline: whatsappHeadlineForStatus(newStatus, row.order_number),
                    detail: reason || "",
                    footer: newStatus === "rejected"
                        ? "Contact support if you have questions about this order."
                        : "Track your order anytime in the app.",
                });
            }
        }
        res.json({ success: true, message: `Order marked as ${newStatus.replace("_", " ")}.` });
    };
}

export const confirmOrder = transitionHandler("confirmed");
export const rejectOrder = transitionHandler("rejected");
export const processOrder = transitionHandler("processing");
export const shipOrder = transitionHandler("shipped");
export const deliverOrder = transitionHandler("delivered");