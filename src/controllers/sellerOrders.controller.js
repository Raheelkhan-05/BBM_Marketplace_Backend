// controllers/sellerOrders.controller.js
import { supabase } from "../config/supabase.js";
import { notifyOrderChanged, notifyUserOrdersChanged, notifyUser } from "../services/realtimeBroadcast.js";
import { sendOrderUpdateWhatsApp } from "../services/whatsapp.service.js";
import { notifyIfWalletJustBlocked } from "../services/walletNotifications.service.js";
import { getTransportOption, transportLabel } from "../../shared/transportOptions.js"; // NEW

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
      buyer_transport_mode, transport_mode, transport_fields, transport_notes, transport_proof_url, transport_confirmed_at, transport_source,
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
// NEW (vendor-block fix): the seller's own order fetch previously had no
// `seller_profiles` join at all — since a seller obviously already knows
// their own shop, that seemed redundant. But PurchaseOrderDocument.jsx
// (shared with the buyer's view) reads `order.seller` for the "Vendor"
// block, and without this join that field is `undefined`, which is what
// was rendering blank on the seller side despite the `vendorOverride`
// fallback (that fallback reads fields off the auth `profile` object that
// don't actually exist there). Joining here — same shape as
// orders.controller.js's getMyOrder — makes both views consistent and
// makes vendorOverride purely a belt-and-suspenders fallback instead of
// the only source of truth.
// NOTE: swap in the real FK constraint name below if this throws — see
// the same caveat left on getMyOrder in orders.controller.js.
export async function getSellerOrder(req, res) {
    const { data: order, error } = await supabase
        .from("orders")
        .select(`
      *,
      seller:seller_profiles!orders_seller_id_fkey (
        id, display_name, shop_slug, logo_url, city, state,
        business:business_profiles!seller_profiles_business_profile_id_fkey ( gstin )
      ),
      items:order_items ( * )
    `)
        .eq("id", req.params.id).eq("seller_id", req.sellerId).neq("status", "awaiting_payment").maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });

    const { data: events } = await supabase.from("order_events").select("*").eq("order_id", order.id).order("created_at");
    res.json({ success: true, order, events: events || [] });
}

// GET /api/seller/orders/transport-options
// NEW — the currently logged-in seller's own configured channels, so the
// frontend can render the ConfirmOrderModal's picker without another
// round trip through the dashboard endpoint.
export async function getOwnTransportOptions(req, res) {
    const { data, error } = await supabase.from("seller_profiles").select("transport_options").eq("id", req.sellerId).maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, transportOptions: data?.transport_options || [] });
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

            const { data: orderRow } = await supabase
                .from("orders")
                .select("buyer_contact_name, buyer_contact_phone, transport_mode, transport_fields")
                .eq("id", req.params.id)
                .maybeSingle();
            if (orderRow?.buyer_contact_phone) {
                const transportDetail = newStatus === "confirmed" && orderRow.transport_mode
                    ? `Transport: ${transportLabel(orderRow.transport_mode)}.`
                    : (reason || "");
                await sendOrderUpdateWhatsApp({
                    to: orderRow.buyer_contact_phone,
                    name: orderRow.buyer_contact_name,
                    headline: whatsappHeadlineForStatus(newStatus, row.order_number),
                    detail: transportDetail,
                    footer: newStatus === "rejected"
                        ? "Contact support if you have questions about this order."
                        : "Track your order anytime in the app.",
                });
            }
        }
        res.json({ success: true, message: `Order marked as ${newStatus.replace("_", " ")}.` });
    };
}

// Internal — actually flips the order to "confirmed" via the shared RPC
// path (order_events row, notifications, wallet accrual, WhatsApp). Not
// exported: always called AFTER the transport details below are saved,
// via confirmOrder().
const runConfirmTransition = transitionHandler("confirmed");

async function uploadTransportProofFile(file, orderId) {
    if (!file) return null;
    const ext = (file.originalname.split(".").pop() || "bin").toLowerCase();
    const path = `${orderId}/${Date.now()}.${ext}`;
    const { error } = await supabase.storage
        .from("order-transport-proof")
        .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
    if (error) throw new Error(error.message);
    const { data } = supabase.storage.from("order-transport-proof").getPublicUrl(path);
    return data.publicUrl;
}

// POST /api/seller/orders/:id/confirm
export async function confirmOrder(req, res) {
    const orderId = req.params.id;
    const { mode, fields, notes } = req.body || {};

    if (!mode) return res.status(400).json({ success: false, message: "Please select a transport method." });

    const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select("id, seller_id, buyer_transport_mode, order_number, status")
        .eq("id", orderId).eq("seller_id", req.sellerId)
        .maybeSingle();
    if (orderErr) return res.status(500).json({ success: false, message: orderErr.message });
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    if (order.status !== "pending_confirmation") {
        return res.status(400).json({ success: false, message: "This order isn't awaiting confirmation." });
    }

    if (order.buyer_transport_mode && order.buyer_transport_mode !== mode) {
        return res.status(400).json({
            success: false,
            message: `The buyer requested ${transportLabel(order.buyer_transport_mode)} for this order.`,
        });
    }

    const optionSchema = getTransportOption(mode);
    if (!optionSchema) return res.status(400).json({ success: false, message: "Unrecognised transport method." });

    const { data: sellerProfile } = await supabase.from("seller_profiles").select("transport_options").eq("id", req.sellerId).maybeSingle();
    const offered = Array.isArray(sellerProfile?.transport_options) ? sellerProfile.transport_options : [];
    if (!offered.includes(mode)) {
        return res.status(400).json({ success: false, message: "You haven't enabled this transport method — update it from Shop Settings." });
    }

    let parsedFields = {};
    try { parsedFields = fields ? JSON.parse(fields) : {}; } catch { parsedFields = {}; }

    const missing = optionSchema.fields.filter((f) => f.required && !String(parsedFields[f.key] || "").trim()).map((f) => f.label);
    if (missing.length) {
        return res.status(400).json({ success: false, message: `Please fill in: ${missing.join(", ")}.` });
    }

    let proofUrl = null;
    try {
        proofUrl = await uploadTransportProofFile(req.file, orderId);
    } catch (e) {
        console.error("[confirmOrder] transport proof upload failed:", e);
        return res.status(500).json({ success: false, message: "Couldn't upload the proof file. Please try again." });
    }

    const { error: updateErr } = await supabase
        .from("orders")
        .update({
            transport_mode: mode,
            transport_fields: parsedFields,
            transport_notes: notes?.trim() || null,
            transport_proof_url: proofUrl,
            transport_confirmed_at: new Date().toISOString(),
            transport_source: order.buyer_transport_mode ? "buyer_requested" : "seller_choice",
        })
        .eq("id", orderId);
    if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });

    return runConfirmTransition(req, res);
}

export const rejectOrder = transitionHandler("rejected");
export const processOrder = transitionHandler("processing");
export const shipOrder = transitionHandler("shipped");
export const deliverOrder = transitionHandler("delivered");