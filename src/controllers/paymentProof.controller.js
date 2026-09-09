// controllers/paymentProof.controller.js
//
// Buyer-side endpoints for the payment flow:
//   GET  /api/orders/:id/payment       -> data needed to render UPI QR + deep link, AND/OR bank
//                                          transfer (NEFT/RTGS) details, whichever the admin has
//                                          configured. Buyer picks a method client-side.
//   POST /api/orders/:id/payment-proof -> submit UTR/reference (+ optional screenshot) + which
//                                          method was used, for admin review
//
// NEFT/RTGS was added alongside the existing UPI QR flow because UPI has a
// per-transaction limit (varies by bank/category, but generally well under
// what a large order can total to) — buyers above that just transfer to the
// platform's bank account instead and submit the same kind of proof.
//
// Wire into your router, e.g.:
//   router.get("/orders/:id/payment", requireAuth, getPaymentInstructions);
//   router.post("/orders/:id/payment-proof", requireAuth, upload.single("screenshot"), submitPaymentProof);
//
// Assumes a multer instance `upload` (memoryStorage) is set up elsewhere and
// passed in as middleware — swap for whatever upload middleware you already
// use elsewhere in the codebase (you clearly have file upload infra already
// for seller photos/certifications).
import { supabase } from "../config/supabase.js";

const PROOF_ERROR_MAP = {
    ORDER_NOT_FOUND: { status: 404, message: "Order not found." },
    NOT_AWAITING_PAYMENT: { status: 400, message: "This order isn't waiting on a payment submission." },
    INVALID_UTR: { status: 400, message: "Please enter a valid UTR / transaction reference number." },
};
function mapProofError(error) {
    return PROOF_ERROR_MAP[(error?.message || "").trim()] || { status: 500, message: "Couldn't submit payment proof. Please try again." };
}

const VALID_PAYMENT_METHODS = new Set(["upi", "neft", "rtgs"]);

// GET /api/orders/:id/payment
// Returns everything the frontend needs to render a UPI QR + "Open in UPI
// app" button, AND/OR NEFT/RTGS bank details — without hitting any external
// payment gateway. Either block can be null if the admin hasn't configured
// that method; the frontend only shows tabs for methods that are present.
export async function getPaymentInstructions(req, res) {
    const { data: order, error } = await supabase
        .from("orders")
        .select("id, order_number, status, payment_status, total_amount")
        .eq("id", req.params.id)
        .eq("buyer_id", req.user.id)
        .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    if (order.status !== "awaiting_payment") {
        return res.status(400).json({ success: false, message: "This order isn't awaiting payment.", status: order.status });
    }

    const { data: settings } = await supabase
        .from("platform_settings")
        .select("upi_vpa, upi_payee_name, bank_account_name, bank_account_number, bank_ifsc, bank_name, bank_branch")
        .eq("id", true)
        .maybeSingle();

    const amount = Number(order.total_amount);
    const note = `Order ${order.order_number}`;

    // upi:// deep link the frontend can both render as a QR and use directly
    // as a clickable link on mobile (browsers/OS route upi:// to installed
    // UPI apps via intent). Null if UPI isn't configured.
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

    // Existing payment proof (if the buyer already tried once and it was
    // rejected, or is still pending review) so the frontend can show status
    // instead of a blank form.
    const { data: existingProof } = await supabase
        .from("payment_proofs")
        .select("id, utr_number, payment_method, status, admin_note, created_at, reviewed_at")
        .eq("order_id", order.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    res.json({
        success: true,
        orderId: order.id,
        orderNumber: order.order_number,
        amount,
        vpa: settings?.upi_vpa || null,
        payeeName: settings?.upi_payee_name || "Merchant",
        note,
        upiUri,
        bankDetails,
        existingProof: existingProof || null,
    });
}

// POST /api/orders/:id/payment-proof  (multipart/form-data: utr, payment_method, screenshot)
export async function submitPaymentProof(req, res) {
    const { utr, payment_method } = req.body || {};
    if (!utr || !utr.trim()) {
        return res.status(400).json({ success: false, message: "Please enter the UTR / transaction reference number." });
    }
    // Default to 'upi' for backward compatibility with any in-flight
    // sessions started before this field existed.
    const paymentMethod = VALID_PAYMENT_METHODS.has(payment_method) ? payment_method : "upi";

    let screenshotUrl = null;
    if (req.file) {
        const ext = (req.file.originalname.split(".").pop() || "jpg").toLowerCase();
        const path = `payment-proofs/${req.params.id}/${Date.now()}.${ext}`;
        const { error: uploadError } = await supabase.storage
            .from("payment-proofs")
            .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
        if (uploadError) {
            console.error("payment screenshot upload failed:", uploadError);
            return res.status(500).json({ success: false, message: "Couldn't upload the screenshot. Please try again." });
        }
        const { data: publicUrl } = supabase.storage.from("payment-proofs").getPublicUrl(path);
        screenshotUrl = publicUrl?.publicUrl || null;
    }

    const { data, error } = await supabase.rpc("submit_payment_proof", {
        p_order_id: req.params.id,
        p_buyer_id: req.user.id,
        p_utr: utr.trim(),
        p_screenshot_url: screenshotUrl,
        p_payment_method: paymentMethod,
    });

    if (error) {
        console.error("submit_payment_proof RPC failed:", error);
        const mapped = mapProofError(error);
        return res.status(mapped.status).json({ success: false, code: error.message, message: mapped.message });
    }

    res.json({
        success: true,
        proofId: data,
        message: "Payment details submitted. We'll confirm your order once it's verified — usually within a few hours.",
    });
}