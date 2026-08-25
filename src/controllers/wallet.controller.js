// controllers/wallet.controller.js
import { supabase } from "../config/supabase.js";

// GET /api/seller/wallet — dashboard summary for the logged-in seller
export async function getWalletStatus(req, res) {
    const { data, error } = await supabase.rpc("wallet_get_status", { p_seller_id: req.sellerId }).single();
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, wallet: data });
}

// GET /api/seller/wallet/transactions
export async function getWalletTransactions(req, res) {
    const { data, error } = await supabase
        .from("wallet_transactions")
        .select("id, order_id, type, amount, billing_period, note, created_at")
        .eq("seller_id", req.sellerId)
        .order("created_at", { ascending: false })
        .limit(100);
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, transactions: data || [] });
}

// NEW — GET /api/seller/wallet/payment-instructions?amount=1000
// Dummy-payment QR details for a wallet top-up, mirroring the shape
// fetchPaymentInstructions returns for order payments (vpa, payeeName,
// note, upiUri) — but built from platform_settings directly since a
// top-up isn't tied to any specific order.
export async function getWalletPaymentInstructions(req, res) {
    const amount = Number(req.query.amount);
    if (!(amount > 0)) return res.status(400).json({ success: false, message: "Enter a valid amount." });

    const { data: settings, error } = await supabase
        .from("platform_settings")
        .select("upi_vpa, upi_payee_name")
        .eq("id", true)
        .maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!settings?.upi_vpa) {
        return res.status(500).json({ success: false, message: "Payment details aren't configured yet. Please contact support." });
    }

    const payeeName = settings.upi_payee_name || "BBM Marketplace";
    const note = "Wallet top-up";
    const upiUri = `upi://pay?pa=${encodeURIComponent(settings.upi_vpa)}&pn=${encodeURIComponent(payeeName)}&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}`;

    res.json({ success: true, amount, vpa: settings.upi_vpa, payeeName, note, upiUri });
}

// POST /api/seller/wallet/payments — seller submits proof of payment
// UPDATED — now accepts an optional multipart screenshot (req.file) in
// addition to amount/utr, same shape as the order payment-proof upload.
// TODO(confirm): this assumes a shared screenshot-storage helper exists
// (the same one paymentProof.controller.js's submitPaymentProof uses for
// order payments) — swap `uploadPaymentScreenshot` below for whatever
// that helper is actually called/imported as in your codebase.
export async function submitWalletPayment(req, res) {
    const { amount, utr } = req.body || {};
    let screenshotUrl = req.body?.screenshotUrl || null;

    if (req.file) {
        // Placeholder — replace with your actual storage upload call.
        // e.g. screenshotUrl = await uploadPaymentScreenshot(req.file.buffer, req.file.mimetype, `wallet/${req.sellerId}/${Date.now()}`);
        try {
            const { uploadPaymentScreenshot } = await import("../utils/paymentScreenshotUpload.js");
            screenshotUrl = await uploadPaymentScreenshot(req.file.buffer, req.file.mimetype, `wallet/${req.sellerId}/${Date.now()}-${req.file.originalname}`);
        } catch (uploadErr) {
            console.error("Wallet screenshot upload failed:", uploadErr);
            return res.status(500).json({ success: false, message: "Couldn't upload the screenshot. Please try again." });
        }
    }

    const { data, error } = await supabase.rpc("wallet_submit_payment", {
        p_seller_id: req.sellerId, p_amount: Number(amount), p_utr: utr || null, p_screenshot_url: screenshotUrl,
    });
    if (error) {
        const map = { INVALID_AMOUNT: "Enter a valid top-up amount." };
        return res.status(400).json({ success: false, code: error.message, message: map[error.message] || "Couldn't submit payment." });
    }
    res.json({ success: true, paymentId: data, message: "Credits submitted — we'll verify it shortly." });
}

// GET /api/seller/wallet/payments — seller's own payment history
export async function listWalletPayments(req, res) {
    const { data, error } = await supabase
        .from("wallet_payments")
        .select("id, amount, billing_period, utr, status, rejection_reason, created_at, verified_at")
        .eq("seller_id", req.sellerId)
        .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, payments: data || [] });
}

// ---- Admin-side (mount under an admin-guarded router) ----

// GET /api/admin/wallet/payments?status=pending
// UPDATED — now also embeds screenshot_url + the seller's own UTR history
// context needed for the unified admin verification UI.
export async function adminListWalletPayments(req, res) {
    const { status = "pending" } = req.query;
    const { data, error } = await supabase
        .from("wallet_payments")
        .select("id, seller_id, amount, billing_period, utr, screenshot_url, status, rejection_reason, created_at, verified_at, seller:seller_profiles(id, display_name, shop_slug)")
        .eq("status", status)
        .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, payments: data || [] });
}

// POST /api/admin/wallet/payments/:id/verify — { approve, rejectionReason }
export async function adminVerifyWalletPayment(req, res) {
    const { approve, rejectionReason } = req.body || {};
    if (!approve && !(rejectionReason || "").trim()) {
        return res.status(400).json({ success: false, message: "Please give a reason so the seller knows what to fix." });
    }
    const { error } = await supabase.rpc("wallet_verify_payment", {
        p_payment_id: req.params.id, p_admin_id: req.user.id,
        p_approve: !!approve, p_rejection_reason: rejectionReason || null,
    });
    if (error) {
        return res.status(error.message === "PAYMENT_NOT_FOUND" ? 404 : 500)
            .json({ success: false, message: error.message === "PAYMENT_NOT_FOUND" ? "Payment not found or already processed." : "Couldn't verify payment." });
    }
    res.json({ success: true, message: approve ? "Payment verified — credits added." : "Payment rejected." });
}

// GET /api/admin/wallet/sellers — every seller's wallet at a glance
export async function adminListSellerWallets(req, res) {
    const { search = "", billingMode = "" } = req.query;

    let query = supabase
        .from("seller_profiles")
        .select(`
      id, display_name, shop_slug,
      wallet:seller_wallets ( balance_due, is_blocked, blocked_reason, current_period, lifetime_accrued, lifetime_paid ),
      settings:seller_wallet_settings ( billing_mode, threshold_amount, set_by_admin_at )
    `)
        .order("display_name");

    if (search.trim()) query = query.ilike("display_name", `%${search.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    let sellers = (data || []).map((s) => ({
        id: s.id,
        displayName: s.display_name,
        shopSlug: s.shop_slug,
        balanceDue: s.wallet?.[0]?.balance_due ?? 0,
        isBlocked: s.wallet?.[0]?.is_blocked ?? false,
        blockedReason: s.wallet?.[0]?.blocked_reason ?? null,
        currentPeriod: s.wallet?.[0]?.current_period ?? null,
        billingMode: s.settings?.[0]?.billing_mode ?? "threshold",
        thresholdAmount: s.settings?.[0]?.threshold_amount ?? 1000,
        setByAdminAt: s.settings?.[0]?.set_by_admin_at ?? null,
    }));

    if (billingMode) sellers = sellers.filter((s) => s.billingMode === billingMode);

    res.json({ success: true, sellers });
}

// PATCH /api/admin/wallet/sellers/:sellerId/settings — { billingMode, thresholdAmount }
export async function adminUpdateSellerWalletSettings(req, res) {
    const { sellerId } = req.params;
    const { billingMode, thresholdAmount } = req.body || {};

    const { error } = await supabase.rpc("wallet_admin_set_settings", {
        p_seller_id: sellerId,
        p_admin_id: req.user.id,
        p_billing_mode: billingMode,
        p_threshold_amount: billingMode === "threshold" ? Number(thresholdAmount) : null,
    });

    if (error) {
        const map = { INVALID_BILLING_MODE: "Choose either threshold or monthly mode.", INVALID_THRESHOLD: "Enter a valid threshold amount." };
        return res.status(400).json({ success: false, code: error.message, message: map[error.message] || "Couldn't update settings." });
    }
    res.json({ success: true, message: `Billing mode set to ${billingMode}.` });
}