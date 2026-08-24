// controllers/groupPaymentProof.controller.js
//
// Buyer-side endpoints for the UPI QR payment flow at the CART/GROUP level:
//   GET  /api/cart/groups/:groupId/payment-instructions -> data needed to render the QR + deep link
//   POST /api/cart/groups/:groupId/payment-proof         -> submit UTR + screenshot for admin review
//
// Mirrors controllers/paymentProof.controller.js exactly, but resolves
// against `order_groups` (one QR/UTR covers every seller order in the group)
// instead of a single `orders` row.
//
// Wire into your router, e.g.:
//   router.get("/cart/groups/:groupId/payment-instructions", requireAuth, getGroupPaymentInstructions);
//   router.post("/cart/groups/:groupId/payment-proof", requireAuth, upload.single("screenshot"), submitGroupPaymentProof);
//
// SCHEMA ASSUMPTIONS (please confirm/adjust to match your actual tables):
//   - `order_groups` has: id, group_number, status, buyer_id, total_amount
//   - `payment_proofs` has an `order_group_id` column alongside the existing
//     `order_id` column (nullable — a proof belongs to exactly one of the two),
//     OR you have a separate `group_payment_proofs` table. This file assumes
//     the former (shared table, extra nullable FK) since it lets admin review
//     reuse the same queue/table as single-order proofs. If you went with a
//     separate table, swap `.from("payment_proofs")` -> `.from("group_payment_proofs")`
//     and drop the `order_group_id` / `order_id` disambiguation below.
//   - A Postgres RPC `submit_group_payment_proof(p_order_group_id, p_buyer_id, p_utr, p_screenshot_url)`
//     exists, mirroring `submit_payment_proof` but validating/updating
//     `order_groups.status` (and cascading to the group's child orders,
//     however your `place_cart_order` models "awaiting_payment" for a group)
//     instead of a single order row.
import { supabase } from "../config/supabase.js";

const GROUP_PROOF_ERROR_MAP = {
    ORDER_GROUP_NOT_FOUND: { status: 404, message: "Order not found." },
    NOT_AWAITING_PAYMENT: { status: 400, message: "This order isn't waiting on a payment submission." },
    INVALID_UTR: { status: 400, message: "Please enter a valid UTR / transaction reference number." },
};
function mapGroupProofError(error) {
    return GROUP_PROOF_ERROR_MAP[(error?.message || "").trim()] || { status: 500, message: "Couldn't submit payment proof. Please try again." };
}

// GET /api/cart/groups/:groupId/payment-instructions
// Returns everything the frontend needs to render a UPI QR + "Open in UPI app"
// button for a whole cart checkout (order group), without hitting any
// external payment gateway.
export async function getGroupPaymentInstructions(req, res) {
    const { data: group, error } = await supabase
        .from("order_groups")
        .select("id, group_number, payment_status, total_amount")
        .eq("id", req.params.groupId)
        .eq("buyer_id", req.user.id)
        .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!group) return res.status(404).json({ success: false, message: "Order not found." });
    if (group.payment_status !== "pending") {
        return res.status(400).json({ success: false, message: "This order isn't awaiting payment.", status: group.payment_status });
    }

    const { data: settings } = await supabase
        .from("platform_settings")
        .select("upi_vpa, upi_payee_name")
        .eq("id", true)
        .maybeSingle();

    if (!settings?.upi_vpa) {
        return res.status(500).json({ success: false, message: "UPI payments aren't configured yet. Please contact support." });
    }

    // Existing payment proof for this group (if the buyer already tried once
    // and it was rejected, or is still pending review).
    const { data: existingProof } = await supabase
        .from("payment_proofs")
        .select("id, utr_number, status, admin_note, created_at, reviewed_at")
        .eq("order_group_id", group.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    const amount = Number(group.total_amount);
    const note = `Order ${group.group_number}`;
    const upiUri = `upi://pay?pa=${encodeURIComponent(settings.upi_vpa)}&pn=${encodeURIComponent(settings.upi_payee_name || "Merchant")}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}`;

    res.json({
        success: true,
        groupId: group.id,
        orderNumber: group.group_number,
        amount,
        vpa: settings.upi_vpa,
        payeeName: settings.upi_payee_name || "Merchant",
        note,
        upiUri,
        existingProof: existingProof || null,
    });
}

// POST /api/cart/groups/:groupId/payment-proof  (multipart/form-data: utr, screenshot)
export async function submitGroupPaymentProof(req, res) {
    const { utr } = req.body || {};
    if (!utr || !utr.trim()) {
        return res.status(400).json({ success: false, message: "Please enter the UTR / transaction reference number." });
    }

    let screenshotUrl = null;
    if (req.file) {
        const ext = (req.file.originalname.split(".").pop() || "jpg").toLowerCase();
        const path = `payment-proofs/groups/${req.params.groupId}/${Date.now()}.${ext}`;
        const { error: uploadError } = await supabase.storage
            .from("payment-proofs")
            .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
        if (uploadError) {
            console.error("group payment screenshot upload failed:", uploadError);
            return res.status(500).json({ success: false, message: "Couldn't upload the screenshot. Please try again." });
        }
        const { data: publicUrl } = supabase.storage.from("payment-proofs").getPublicUrl(path);
        screenshotUrl = publicUrl?.publicUrl || null;
    }

    const { data, error } = await supabase.rpc("submit_group_payment_proof", {
        p_group_id: req.params.groupId,
        p_buyer_id: req.user.id,
        p_utr: utr.trim(),
        p_screenshot_url: screenshotUrl,
    });

    if (error) {
        console.error("submit_group_payment_proof RPC failed:", error);
        const mapped = mapGroupProofError(error);
        return res.status(mapped.status).json({ success: false, code: error.message, message: mapped.message });
    }

    res.json({
        success: true,
        proofId: data,
        message: "Payment details submitted. We'll confirm your orders once it's verified — usually within a few hours.",
    });
}