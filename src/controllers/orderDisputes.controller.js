// controllers/orderDisputes.controller.js
//
// Buyer + seller side of:
//   * cancelling an order with a reason (replaces cancelMyOrder in orders.controller.js)
//   * raising a dispute inside the 48h post-delivery window
//   * viewing a dispute / seller replying to it
//
// Money state is NEVER changed here — the window check, the hold and the
// release/refund all live in SQL (see sql/2026_10_dispute_window.sql).
import crypto from "node:crypto";
import { supabase } from "../config/supabase.js";
import { notifyUser, notifyOrderChanged, notifyUserOrdersChanged } from "../services/realtimeBroadcast.js";
import { notifyAdmins } from "../services/notifications.service.js";
import { notifyIfWalletJustBlocked } from "../services/walletNotifications.service.js";
import { processRefundQueue } from "../services/payments.service.js";
import {
    CANCELLABLE_STATUSES, CANCEL_REASONS, MAX_CANCEL_TEXT,
    DESIRED_RESOLUTIONS, findCategory, labelFor,
    MIN_DESCRIPTION_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_EVIDENCE_FILES, EVIDENCE_MIME_TYPES,
} from "../../shared/disputeConfig.js";

const EVIDENCE_BUCKET = "dispute-evidence";

// Columns a buyer/seller may see. Deliberately excludes admin_internal_note,
// assigned_admin_id, resolved_by and retained_amount.
const PARTY_DISPUTE_COLUMNS = `
  id, dispute_number, order_id, category, sub_reason, details, description, desired_resolution,
  evidence_urls, status, seller_response, seller_response_evidence, seller_responded_at,
  resolution_type, refund_amount, seller_payout_amount, resolution_note, resolved_at, created_at
`;

const RAISE_ERRORS = {
    ORDER_NOT_FOUND: [404, "Order not found."],
    NOT_DELIVERED: [400, "You can report an issue only after the order is delivered."],
    NOT_ELIGIBLE: [400, "Sample orders can't be disputed."],
    WINDOW_CLOSED: [400, "The dispute window for this order has closed."],
    DISPUTE_EXISTS: [400, "A dispute has already been raised for this order."],
};

async function uploadEvidence(files, orderId, folder) {
    return Promise.all((files || []).map(async (file) => {
        const ext = (file.originalname.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
        const path = `${orderId}/${folder}-${crypto.randomUUID()}.${ext}`;
        const { error } = await supabase.storage.from(EVIDENCE_BUCKET)
            .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
        if (error) throw new Error(error.message);
        const { data } = supabase.storage.from(EVIDENCE_BUCKET).getPublicUrl(path);
        return { url: data.publicUrl, name: String(file.originalname || "file").slice(0, 120), type: file.mimetype };
    }));
}

function filesAreValid(files) {
    if ((files || []).length > MAX_EVIDENCE_FILES) return `You can attach up to ${MAX_EVIDENCE_FILES} files.`;
    if ((files || []).some((f) => !EVIDENCE_MIME_TYPES.includes(f.mimetype))) return "Only JPG, PNG, WebP or PDF files are allowed.";
    return null;
}

// ---------------------------------------------------------------------
// POST /api/orders/:id/cancel   { reasonCode, reasonText }
// ---------------------------------------------------------------------
export async function cancelMyOrder(req, res) {
    const orderId = req.params.id;
    const body = req.body || {};

    // Legacy clients only sent { reason } — treat it as "other".
    let reasonCode = typeof body.reasonCode === "string" ? body.reasonCode : null;
    let reasonText = typeof body.reasonText === "string" ? body.reasonText.trim() : "";
    if (!reasonCode && typeof body.reason === "string" && body.reason.trim()) { reasonCode = "other"; reasonText = body.reason.trim(); }

    if (!reasonCode || !CANCEL_REASONS.some((r) => r.code === reasonCode)) {
        return res.status(400).json({ success: false, code: "REASON_REQUIRED", message: "Please tell us why you're cancelling this order." });
    }
    if (reasonCode === "other" && reasonText.length < 3) {
        return res.status(400).json({ success: false, code: "REASON_TEXT_REQUIRED", message: "Please describe your reason." });
    }
    if (reasonText.length > MAX_CANCEL_TEXT) reasonText = reasonText.slice(0, MAX_CANCEL_TEXT);

    const { data: order, error: orderErr } = await supabase
        .from("orders").select("id, buyer_id, status, order_number, order_group_id")
        .eq("id", orderId).eq("buyer_id", req.user.id).maybeSingle();
    if (orderErr) return res.status(500).json({ success: false, message: "Couldn't cancel the order." });
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    if (!CANCELLABLE_STATUSES.includes(order.status)) {
        return res.status(400).json({ success: false, code: "INVALID_TRANSITION", message: "This order can no longer be cancelled." });
    }

    if (order.status === "awaiting_payment") {
        let proofQ = supabase.from("payment_proofs").select("id", { count: "exact", head: true }).eq("status", "pending");
        proofQ = order.order_group_id ? proofQ.eq("order_group_id", order.order_group_id) : proofQ.eq("order_id", orderId);
        const { count, error: proofErr } = await proofQ;
        if (proofErr) {
            console.error("[cancelMyOrder] proof check failed:", proofErr.message);
            return res.status(500).json({ success: false, message: "Couldn't cancel the order." });
        }
        if (count > 0) {
            return res.status(400).json({ success: false, code: "PAYMENT_UNDER_REVIEW", message: "Your payment is being verified, so this order can't be cancelled right now. Please contact support if it's a mistake." });
        }
    }

    const label = labelFor(CANCEL_REASONS, reasonCode);
    const note = reasonText ? `${label}: ${reasonText}` : label;
    const wasUnpaid = order.status === "awaiting_payment";
    let row = null;

    if (wasUnpaid && order.order_group_id) {
        // Cart checkout: unpaid orders share ONE payment (the group total), so the
        // whole pending group is cancelled together — same RPC the cart uses
        // when its contents change.
        const { error } = await supabase.rpc("cancel_pending_order_group_if_exists", { p_buyer_id: req.user.id });
        if (error) return res.status(500).json({ success: false, message: "Couldn't cancel the order." });
        const { data: after } = await supabase.from("orders").select("status").eq("id", orderId).maybeSingle();
        if (after?.status !== "cancelled") {
            return res.status(400).json({ success: false, code: "INVALID_TRANSITION", message: "This order can no longer be cancelled." });
        }
    } else {
        const { data, error } = await supabase.rpc("update_order_status", {
            p_order_id: orderId, p_actor_role: "buyer", p_actor_user_id: req.user.id,
            p_new_status: "cancelled", p_note: note,
        });
        if (error) {
            const status = { FORBIDDEN: 403, ORDER_NOT_FOUND: 404, INVALID_TRANSITION: 400 }[error.message] || 500;
            return res.status(status).json({
                success: false, code: error.message,
                message: status === 400 ? "This order can no longer be cancelled." : "Couldn't cancel the order.",
            });
        }
        row = Array.isArray(data) ? data[0] : data;
    }

    // Persist the structured reason (best effort — the order IS cancelled either way).
    let reasonUpdate = supabase.from("orders")
        .update({ cancel_reason_code: reasonCode, cancel_reason_text: reasonText || null })
        .eq("buyer_id", req.user.id).eq("status", "cancelled");
    reasonUpdate = wasUnpaid && order.order_group_id ? reasonUpdate.eq("order_group_id", order.order_group_id) : reasonUpdate.eq("id", orderId);
    const { error: reasonErr } = await reasonUpdate;
    if (reasonErr) console.error("[cancelMyOrder] couldn't store cancel reason:", reasonErr.message);

    await notifyOrderChanged(orderId, { status: "cancelled" });
    await notifyUserOrdersChanged(req.user.id);

    // Commission was only ever accrued once an order left awaiting_payment.
    if (!wasUnpaid) {
        await supabase.rpc("wallet_reverse_commission", { p_order_id: orderId });
        const { data: orderForWallet } = await supabase.from("orders").select("seller_id").eq("id", orderId).maybeSingle();
        if (orderForWallet?.seller_id && row?.notify_user_id) {
            await notifyIfWalletJustBlocked({ sellerId: orderForWallet.seller_id, sellerUserId: row.notify_user_id });
        }
        if (row?.notify_user_id) {
            await notifyUser(row.notify_user_id, {
                type: "order_status_cancelled",
                title: `Order ${row.order_number} cancelled`,
                body: `The buyer cancelled this order. Reason: ${note}`,
                link: `/seller/orders/${orderId}`,
            });
            await notifyUserOrdersChanged(row.notify_user_id);
        }
    }

    if (!wasUnpaid) processRefundQueue().catch((e) => console.error("[cancelMyOrder] refund kick failed:", e?.message || e));
    res.json({ success: true, message: "Order cancelled." });
}

// ---------------------------------------------------------------------
// POST /api/orders/:id/dispute   (multipart: evidence[] + fields)
// ---------------------------------------------------------------------
export async function raiseDispute(req, res) {
    const orderId = req.params.id;
    const files = req.files || [];
    const body = req.body || {};

    const category = findCategory(body.category);
    if (!category) return res.status(400).json({ success: false, message: "Please choose what the issue is about." });

    const subReason = typeof body.subReason === "string" ? body.subReason : "";
    if (category.subReasons.length && !category.subReasons.some((s) => s.code === subReason)) {
        return res.status(400).json({ success: false, message: "Please choose the specific problem." });
    }

    let rawDetails = {};
    try { rawDetails = body.details ? JSON.parse(body.details) : {}; } catch { rawDetails = {}; }
    const details = {};
    for (const f of category.detailFields) {
        const v = typeof rawDetails?.[f.key] === "string" ? rawDetails[f.key].trim().slice(0, 300) : "";
        if (f.type === "select" && v && !f.options.some((o) => o.value === v)) {
            return res.status(400).json({ success: false, message: `Invalid value for "${f.label}".` });
        }
        if (f.required && !v) return res.status(400).json({ success: false, message: `Please answer: ${f.label}` });
        if (v) details[f.key] = v;
    }

    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (description.length < MIN_DESCRIPTION_LENGTH) {
        return res.status(400).json({ success: false, message: `Please describe the issue (at least ${MIN_DESCRIPTION_LENGTH} characters).` });
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
        return res.status(400).json({ success: false, message: `Description is too long (max ${MAX_DESCRIPTION_LENGTH} characters).` });
    }
    if (!DESIRED_RESOLUTIONS.some((r) => r.code === body.desiredResolution)) {
        return res.status(400).json({ success: false, message: "Please tell us what outcome you're looking for." });
    }
    const fileError = filesAreValid(files);
    if (fileError) return res.status(400).json({ success: false, message: fileError });
    if (category.evidenceRequired && files.length === 0) {
        return res.status(400).json({ success: false, message: "Please attach at least one photo or document as proof." });
    }

    // Fast pre-check so we don't upload files for a dispute that can't be raised.
    // The RPC below re-checks everything under a row lock — it is the authority.
    const { data: order } = await supabase
        .from("orders").select("id, status, order_type, dispute_window_ends_at")
        .eq("id", orderId).eq("buyer_id", req.user.id).maybeSingle();
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    if (order.status !== "delivered") return res.status(400).json({ success: false, message: RAISE_ERRORS.NOT_DELIVERED[1] });
    if (order.dispute_window_ends_at && new Date(order.dispute_window_ends_at) < new Date()) {
        return res.status(400).json({ success: false, code: "WINDOW_CLOSED", message: RAISE_ERRORS.WINDOW_CLOSED[1] });
    }

    let evidence = [];
    try { evidence = await uploadEvidence(files, orderId, "buyer"); }
    catch (e) {
        console.error("[raiseDispute] upload failed:", e?.message || e);
        return res.status(500).json({ success: false, message: "Couldn't upload your files. Please try again." });
    }

    const { data, error } = await supabase.rpc("raise_order_dispute", {
        p_order_id: orderId, p_buyer_id: req.user.id, p_category: category.code, p_sub_reason: subReason || null,
        p_details: details, p_description: description, p_desired_resolution: body.desiredResolution, p_evidence: evidence,
    });
    if (error) {
        const [status, message] = RAISE_ERRORS[(error.message || "").trim()] || [500, "Couldn't raise the dispute. Please try again."];
        if (status === 500) console.error("[raiseDispute] rpc failed:", error);
        return res.status(status).json({ success: false, code: (error.message || "").trim(), message });
    }
    const row = Array.isArray(data) ? data[0] : data;

    await notifyOrderChanged(orderId, { status: "delivered", dispute: "open" });
    await notifyUserOrdersChanged(req.user.id);
    if (row?.r_seller_user_id) {
        await notifyUser(row.r_seller_user_id, {
            type: "dispute_raised",
            title: `Dispute raised on order ${row.r_order_number}`,
            body: `The buyer reported: ${category.label}. Your payout for this order is on hold — please respond with your side.`,
            link: `/seller/orders/${orderId}`,
        });
        await notifyUserOrdersChanged(row.r_seller_user_id);
    }
    await notifyAdmins({
        type: "dispute_raised",
        title: `New dispute ${row?.r_dispute_number || ""} — order ${row?.r_order_number || ""}`,
        body: `${category.label}. Seller payout is on hold pending review.`,
        link: `/disputes/${row?.r_dispute_id || ""}`,
    });

    res.json({ success: true, disputeId: row?.r_dispute_id, disputeNumber: row?.r_dispute_number, message: "Dispute raised. Our team will review it." });
}

async function loadDisputeWithEvents(orderId) {
    const { data: dispute, error } = await supabase
        .from("order_disputes").select(PARTY_DISPUTE_COLUMNS).eq("order_id", orderId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!dispute) return { dispute: null, events: [] };
    const { data: events, error: evErr } = await supabase
        .from("order_dispute_events")
        .select("id, actor_role, event_type, note, meta, created_at")
        .eq("dispute_id", dispute.id).eq("visible_to_parties", true).order("created_at");
    if (evErr) throw new Error(evErr.message);
    return { dispute, events: events || [] };
}

// GET /api/orders/:id/dispute
export async function getBuyerDispute(req, res) {
    const { data: order } = await supabase.from("orders").select("id").eq("id", req.params.id).eq("buyer_id", req.user.id).maybeSingle();
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    try {
        const { dispute, events } = await loadDisputeWithEvents(order.id);
        res.json({ success: true, dispute, events, serverNow: new Date().toISOString() });
    } catch (e) {
        console.error("[getBuyerDispute]", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't load the dispute." });
    }
}

// GET /api/seller/orders/:id/dispute
export async function getSellerDispute(req, res) {
    const { data: order } = await supabase.from("orders").select("id").eq("id", req.params.id).eq("seller_id", req.sellerId).maybeSingle();
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    try {
        const { dispute, events } = await loadDisputeWithEvents(order.id);
        res.json({ success: true, dispute, events, serverNow: new Date().toISOString() });
    } catch (e) {
        console.error("[getSellerDispute]", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't load the dispute." });
    }
}

// POST /api/seller/orders/:id/dispute/respond   (multipart: evidence[] + response)
export async function sellerRespondToDispute(req, res) {
    const orderId = req.params.id;
    const response = typeof req.body?.response === "string" ? req.body.response.trim() : "";
    const files = req.files || [];

    if (response.length < MIN_DESCRIPTION_LENGTH) {
        return res.status(400).json({ success: false, message: `Please write your response (at least ${MIN_DESCRIPTION_LENGTH} characters).` });
    }
    if (response.length > MAX_DESCRIPTION_LENGTH) {
        return res.status(400).json({ success: false, message: `Response is too long (max ${MAX_DESCRIPTION_LENGTH} characters).` });
    }
    const fileError = filesAreValid(files);
    if (fileError) return res.status(400).json({ success: false, message: fileError });

    const { data: order } = await supabase.from("orders").select("id, order_number, buyer_id")
        .eq("id", orderId).eq("seller_id", req.sellerId).maybeSingle();
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });

    const { data: dispute } = await supabase.from("order_disputes")
        .select("id, status, seller_response_evidence").eq("order_id", orderId).maybeSingle();
    if (!dispute) return res.status(404).json({ success: false, message: "There's no dispute on this order." });
    if (dispute.status === "resolved") return res.status(400).json({ success: false, message: "This dispute has already been resolved." });

    let evidence = [];
    try { evidence = await uploadEvidence(files, orderId, "seller"); }
    catch (e) {
        console.error("[sellerRespondToDispute] upload failed:", e?.message || e);
        return res.status(500).json({ success: false, message: "Couldn't upload your files. Please try again." });
    }
    const merged = [...(dispute.seller_response_evidence || []), ...evidence].slice(-8);

    const { error } = await supabase.from("order_disputes")
        .update({ seller_response: response, seller_response_evidence: merged, seller_responded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", dispute.id).neq("status", "resolved");
    if (error) return res.status(500).json({ success: false, message: "Couldn't save your response." });

    await supabase.from("order_dispute_events").insert({
        dispute_id: dispute.id, order_id: orderId, actor_role: "seller", actor_user_id: req.user.id,
        event_type: "seller_responded", note: response, meta: { evidence_count: evidence.length },
    });

    await notifyOrderChanged(orderId, { status: "delivered", dispute: "responded" });
    await notifyUser(order.buyer_id, {
        type: "dispute_seller_responded", title: `Seller responded on order ${order.order_number}`,
        body: "The seller has shared their side. Our team will review both and decide.", link: `/orders/${orderId}`,
    });
    await notifyUserOrdersChanged(order.buyer_id);
    await notifyAdmins({
        type: "dispute_seller_responded", title: `Seller responded — order ${order.order_number}`,
        body: "New information is available on a dispute under review.", link: `/disputes/${dispute.id}`,
    });

    res.json({ success: true, message: "Response submitted." });
}