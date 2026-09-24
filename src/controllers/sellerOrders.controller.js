// controllers/sellerOrders.controller.js
//
// CHANGED (Transport Library pass):
// - confirmOrder no longer collects transport details — the buyer and
//   seller already agreed on a transport option BEFORE purchase, via the
//   Transport Library (see controllers/transportLibrary.controller.js and
//   place_order's new p_transport_route_option_id param). Confirming an
//   order is now a plain approval step. It only falls back to asking for
//   a `mode` when an order somehow has none set (legacy/edge case).
// - "processing" is removed from the seller-driven flow. Confirmed orders
//   go straight to "shipped".
// - shipOrder is NEW and replaces the old bare status flip: the seller
//   must upload an LR (their reference document for the buyer, e.g. an
//   LR/consignment note photo or PDF) AND a bill for the order before the
//   status can move to "shipped". Company-level transport info (which
//   company, branch, contact) is already on the order from place_order —
//   this step only asks for the LR number/proof and the bill.
import { supabase } from "../config/supabase.js";
import { notifyOrderChanged, notifyUserOrdersChanged, notifyUser } from "../services/realtimeBroadcast.js";
import { sendOrderUpdateWhatsApp } from "../services/whatsapp.service.js";
import { notifyIfWalletJustBlocked } from "../services/walletNotifications.service.js";
import { getTransportOption, transportLabel } from "../../shared/transportOptions.js";
import { routeOptionSummary } from "../../shared/routeTransportFields.js";

function whatsappHeadlineForStatus(newStatus, orderNumber) {
    const map = {
        confirmed: `Your order #${orderNumber} has been confirmed by the seller.`,
        rejected: `Your order #${orderNumber} was rejected by the seller.`,
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
      payment_status, payment_method, buyer_contact_name, buyer_contact_phone, buyer_contact_email,
      buyer_gstin, buyer_business_name, buyer_gst_verified,
      shipping_address_snapshot, buyer_notes, created_at, updated_at,
      buyer_transport_mode, transport_mode, transport_fields, transport_route_option_id,
      ship_lr_number, ship_bill_url, ship_details_confirmed_at,
      items:order_items (
        id, product_name_snapshot, brand_name_snapshot, image_snapshot, unit_price, base_price_applied,
        discount_percent, unit, quantity, purchase_basis, pack_quantity_snapshot, lead_time_snapshot, line_total,
        seller_product_submission_id,
        submission:seller_product_submissions ( freight_terms )
      )
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
// GET /api/seller/orders/:id
export async function getSellerOrder(req, res) {
    const { data: order, error } = await supabase
        .from("orders")
        .select(`
      *,
      seller:seller_profiles!orders_seller_id_fkey (
        id, display_name, shop_slug, logo_url, city, state,
        business:business_profiles!seller_profiles_business_profile_id_fkey ( gstin )
      ),
      items:order_items (
        *,
        submission:seller_product_submissions ( freight_terms )
      )
    `)
        .eq("id", req.params.id).eq("seller_id", req.sellerId).neq("status", "awaiting_payment").maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });

    const { data: events } = await supabase.from("order_events").select("*").eq("order_id", order.id).order("created_at");
    res.json({ success: true, order, events: events || [] });
}

// GET /api/seller/orders/transport-options
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
                body: newStatus === "shipped"
                    ? "Your order has shipped — the LR details and bill are attached to your order."
                    : (reason || `Your order status was updated to ${newStatus.replace("_", " ")}.`),
                link: `/orders/${req.params.id}`,
            });
            await notifyUserOrdersChanged(row.notify_user_id);

            const { data: orderRow } = await supabase
                .from("orders")
                .select("buyer_contact_name, buyer_contact_phone, transport_mode, transport_fields, ship_lr_number")
                .eq("id", req.params.id)
                .maybeSingle();
            if (orderRow?.buyer_contact_phone) {
                let transportDetail = reason || "";
                if (newStatus === "shipped") {
                    const companyLabel = routeOptionSummary(orderRow.transport_mode, orderRow.transport_fields || {});
                    transportDetail = `Shipped via ${companyLabel}. LR/tracking no.: ${orderRow.ship_lr_number || "—"}. Check your order for the LR document and bill.`;
                }
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

const runConfirmTransition = transitionHandler("confirmed");
const runShipTransition = transitionHandler("shipped");

// POST /api/seller/orders/:id/confirm
// Transport is agreed pre-purchase now (Transport Library) — this is a
// plain approval. Only falls back to asking for `mode` if an order
// somehow has no transport_mode set at all (e.g. buyer skipped selecting
// a preference and none was ever attached).
export async function confirmOrder(req, res) {
    const orderId = req.params.id;

    const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select("id, seller_id, status, transport_mode")
        .eq("id", orderId).eq("seller_id", req.sellerId)
        .maybeSingle();
    if (orderErr) return res.status(500).json({ success: false, message: orderErr.message });
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    if (order.status !== "pending_confirmation") {
        return res.status(400).json({ success: false, message: "This order isn't awaiting confirmation." });
    }

    // if (!order.transport_mode) {
    //     const { mode } = req.body || {};
    //     if (!mode) {
    //         return res.status(400).json({ success: false, code: "TRANSPORT_MODE_REQUIRED", message: "Please select a transport method for this order before confirming." });
    //     }
    //     const optionSchema = getTransportOption(mode);
    //     if (!optionSchema) return res.status(400).json({ success: false, message: "Unrecognised transport method." });

    //     const { data: sellerProfile } = await supabase.from("seller_profiles").select("transport_options").eq("id", req.sellerId).maybeSingle();
    //     const offered = Array.isArray(sellerProfile?.transport_options) ? sellerProfile.transport_options : [];
    //     if (!offered.includes(mode)) {
    //         return res.status(400).json({ success: false, message: "You haven't enabled this transport method — update it from Shop Settings." });
    //     }

    //     const { error: updateErr } = await supabase
    //         .from("orders")
    //         .update({ transport_mode: mode, transport_source: "seller_choice" })
    //         .eq("id", orderId);
    //     if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });
    // }

    return runConfirmTransition(req, res);
}

async function uploadShipmentFile(file, orderId, kind) {
    const ext = (file.originalname.split(".").pop() || "bin").toLowerCase();
    const path = `${orderId}/${kind}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage
        .from("order-shipment-docs")
        .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
    if (error) throw new Error(error.message);
    const { data } = supabase.storage.from("order-shipment-docs").getPublicUrl(path);
    return data.publicUrl;
}

// POST /api/seller/orders/:id/ship
// multipart/form-data: fields lrNumber, lrNotes; files lr_proof, bill
// (both required). Replaces the previous bare "processing"/"shipped"
// status flip and folds in what used to be collected at confirm time —
// but now scoped to the actual shipment, not the transport company
// choice (which is already fixed from place_order).
export async function shipOrder(req, res) {
    const orderId = req.params.id;
    const { lrNumber, lrNotes } = req.body || {};

    if (!lrNumber || !lrNumber.trim()) {
        return res.status(400).json({ success: false, message: "Please enter the LR / tracking number." });
    }

    const lrFile = req.files?.lr_proof?.[0];
    const billFile = req.files?.bill?.[0];
    if (!lrFile) return res.status(400).json({ success: false, message: "Please upload the LR document for the buyer's reference." });
    if (!billFile) return res.status(400).json({ success: false, message: "Please upload the bill for this order." });

    const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select("id, seller_id, status, order_number")
        .eq("id", orderId).eq("seller_id", req.sellerId)
        .maybeSingle();
    if (orderErr) return res.status(500).json({ success: false, message: orderErr.message });
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    if (!["confirmed", "processing"].includes(order.status)) {
        return res.status(400).json({ success: false, message: "This order isn't ready to be shipped." });
    }

    let lrProofUrl, billUrl;
    try {
        lrProofUrl = await uploadShipmentFile(lrFile, orderId, "lr");
        billUrl = await uploadShipmentFile(billFile, orderId, "bill");
    } catch (e) {
        console.error("[shipOrder] upload failed:", e?.message || e);
        return res.status(500).json({ success: false, message: "Couldn't upload one of the files. Please try again." });
    }

    const { error: updateErr } = await supabase
        .from("orders")
        .update({
            ship_lr_number: lrNumber.trim(),
            ship_lr_notes: lrNotes?.trim() || null,
            ship_lr_proof_url: lrProofUrl,
            ship_bill_url: billUrl,
            ship_details_confirmed_at: new Date().toISOString(),
        })
        .eq("id", orderId);
    if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });

    return runShipTransition(req, res);
}

export const rejectOrder = transitionHandler("rejected");
export const deliverOrder = transitionHandler("delivered");

// Kept for backward compatibility with any orders/tools still calling it
// directly — no longer routed from the seller UI (see routes file: the
// "processing" step is skipped, confirmed -> shipped directly).
export const processOrder = transitionHandler("processing");