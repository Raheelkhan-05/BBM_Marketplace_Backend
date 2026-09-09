// controllers/groupPaymentProof.controller.js
//
// Buyer-side endpoints for the payment flow at the CART/GROUP level:
//   GET  /api/cart/groups/:groupId/payment-instructions -> UPI QR + deep link AND/OR NEFT/RTGS
//                                                            bank details for the whole group
//   POST /api/cart/groups/:groupId/payment-proof         -> submit UTR/reference + method (+
//                                                            optional screenshot) for admin review
//
// Mirrors controllers/paymentProof.controller.js exactly, but resolves
// against `order_groups` (one proof covers every seller order in the group)
// instead of a single `orders` row.
//
// Wire into your router, e.g.:
//   router.get("/cart/groups/:groupId/payment-instructions", requireAuth, getGroupPaymentInstructions);
//   router.post("/cart/groups/:groupId/payment-proof", requireAuth, upload.single("screenshot"), submitGroupPaymentProof);
//
// SCHEMA ASSUMPTIONS (please confirm/adjust to match your actual tables):
//   - `order_groups` has: id, group_number, status, buyer_id, total_amount
//   - `payment_proofs` has an `order_group_id` column alongside the existing
//     `order_id` column (nullable — a proof belongs to exactly one of the
//     two), plus the new `payment_method` enum column from
//     001_add_neft_rtgs_support.sql
//   - A Postgres RPC `submit_group_payment_proof(p_group_id, p_buyer_id, p_utr, p_screenshot_url, p_payment_method)`
//     exists, mirroring `submit_payment_proof` but validating/updating
//     `order_groups` (and cascading to the group's child orders) instead of
//     a single order row.
import { supabase } from "../config/supabase.js";

const GROUP_PROOF_ERROR_MAP = {
    ORDER_GROUP_NOT_FOUND: { status: 404, message: "Order not found." },
    NOT_AWAITING_PAYMENT: { status: 400, message: "This order isn't waiting on a payment submission." },
    INVALID_UTR: { status: 400, message: "Please enter a valid UTR / transaction reference number." },
};
function mapGroupProofError(error) {
    return GROUP_PROOF_ERROR_MAP[(error?.message || "").trim()] || { status: 500, message: "Couldn't submit payment proof. Please try again." };
}

const VALID_PAYMENT_METHODS = new Set(["upi", "neft", "rtgs"]);

// GET /api/cart/groups/:groupId/payment-instructions
// Returns everything the frontend needs to render a UPI QR + "Open in UPI
// app" button, AND/OR NEFT/RTGS bank details, for a whole cart checkout
// (order group). Either block can be null if the admin hasn't configured
// that method.
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
        .select("upi_vpa, upi_payee_name, bank_account_name, bank_account_number, bank_ifsc, bank_name, bank_branch")
        .eq("id", true)
        .maybeSingle();

    const amount = Number(group.total_amount);
    const note = `Order ${group.group_number}`;

    const upiUri = settings?.upi_vpa
        ? `upi://pay?pa=${encodeURIComponent(settings.upi_vpa)}&pn=${encodeURIComponent(settings.upi_payee_name || "Merchant")}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}`
        : null;

    const bankDetails = settings?.bank_account_number
        ? {
            accountName: settings.bank_account_name || settings.upi_payee_name || "Merchant",
            accountNumber: settings.bank_account_number,
            ifsc: settings.bank_ifsc,
            bankName: settings.bank_name,
            branch: settings.bank_branch || null,
        }
        : null;

    if (!upiUri && !bankDetails) {
        return res.status(500).json({ success: false, message: "Payments aren't configured yet. Please contact support." });
    }

    // Existing payment proof for this group (if the buyer already tried once
    // and it was rejected, or is still pending review).
    const { data: existingProof } = await supabase
        .from("payment_proofs")
        .select("id, utr_number, payment_method, status, admin_note, created_at, reviewed_at")
        .eq("order_group_id", group.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    res.json({
        success: true,
        groupId: group.id,
        orderNumber: group.group_number,
        amount,
        vpa: settings?.upi_vpa || null,
        payeeName: settings?.upi_payee_name || "Merchant",
        note,
        upiUri,
        bankDetails,
        existingProof: existingProof || null,
    });
}

// POST /api/cart/groups/:groupId/payment-proof  (multipart/form-data: utr, payment_method, screenshot)
export async function submitGroupPaymentProof(req, res) {
    const { utr, payment_method } = req.body || {};
    if (!utr || !utr.trim()) {
        return res.status(400).json({ success: false, message: "Please enter the UTR / transaction reference number." });
    }
    const paymentMethod = VALID_PAYMENT_METHODS.has(payment_method) ? payment_method : "upi";

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
        p_payment_method: paymentMethod,
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