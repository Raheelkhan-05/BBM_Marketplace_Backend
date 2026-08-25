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

// PATCH /api/seller/wallet/settings — { billingMode, thresholdAmount }
export async function updateWalletSettings(req, res) {
    const { billingMode, thresholdAmount } = req.body || {};
    if (!["threshold", "monthly"].includes(billingMode)) {
        return res.status(400).json({ success: false, message: "Invalid billing mode." });
    }
    if (billingMode === "threshold" && !(Number(thresholdAmount) > 0)) {
        return res.status(400).json({ success: false, message: "Enter a valid threshold amount." });
    }

    const { error } = await supabase.from("seller_wallet_settings").upsert({
        seller_id: req.sellerId,
        billing_mode: billingMode,
        threshold_amount: billingMode === "threshold" ? Number(thresholdAmount) : 1000,
        updated_at: new Date().toISOString(),
    });
    if (error) return res.status(500).json({ success: false, message: error.message });

    // Mode/threshold change can change the blocking outcome immediately
    await supabase.rpc("wallet_recompute_block_status", { p_seller_id: req.sellerId });
    res.json({ success: true, message: "Wallet settings updated." });
}

// POST /api/seller/wallet/payments — seller submits proof of payment
export async function submitWalletPayment(req, res) {
    const { amount, utr, screenshotUrl } = req.body || {};
    const { data, error } = await supabase.rpc("wallet_submit_payment", {
        p_seller_id: req.sellerId, p_amount: Number(amount), p_utr: utr || null, p_screenshot_url: screenshotUrl || null,
    });
    if (error) {
        const map = { NOTHING_DUE: "There's nothing due right now.", INVALID_AMOUNT: "Enter a valid amount, not exceeding your balance due." };
        return res.status(400).json({ success: false, code: error.message, message: map[error.message] || "Couldn't submit payment." });
    }
    res.json({ success: true, paymentId: data, message: "Payment submitted — we'll verify it shortly." });
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
export async function adminListWalletPayments(req, res) {
    const { status = "pending" } = req.query;
    const { data, error } = await supabase
        .from("wallet_payments")
        .select("*, seller:seller_profiles(id, display_name, shop_slug)")
        .eq("status", status)
        .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, payments: data || [] });
}

// POST /api/admin/wallet/payments/:id/verify — { approve, rejectionReason }
export async function adminVerifyWalletPayment(req, res) {
    const { approve, rejectionReason } = req.body || {};
    const { error } = await supabase.rpc("wallet_verify_payment", {
        p_payment_id: req.params.id, p_admin_id: req.user.id,
        p_approve: !!approve, p_rejection_reason: rejectionReason || null,
    });
    if (error) {
        return res.status(error.message === "PAYMENT_NOT_FOUND" ? 404 : 500)
            .json({ success: false, message: error.message === "PAYMENT_NOT_FOUND" ? "Payment not found or already processed." : "Couldn't verify payment." });
    }
    res.json({ success: true, message: approve ? "Payment verified." : "Payment rejected." });
}

// controllers/wallet.controller.js — REPLACE updateWalletSettings entirely.
// Sellers no longer have a write path for billing mode/threshold — this
// endpoint is removed. Everything else (getWalletStatus, getWalletTransactions,
// submitWalletPayment, listWalletPayments) stays exactly as before.

// GET /api/admin/wallet/sellers — every seller's wallet at a glance, for
// the admin to review and set billing modes. Supports a simple text filter
// on name/shop slug so this stays usable once there are hundreds of sellers.
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

    // Sellers with no wallet row yet (never had an order) still need to show
    // up with sane defaults rather than being silently dropped.
    let sellers = (data || []).map((s) => ({
        id: s.id,
        displayName: s.display_name,
        shopSlug: s.shop_slug,
        balanceDue: s.wallet?.[0]?.balance_due ?? 0,
        isBlocked: s.wallet?.[0]?.is_blocked ?? false,
        blockedReason: s.wallet?.[0]?.blocked_reason ?? null,
        currentPeriod: s.wallet?.[0]?.current_period ?? null,
        billingMode: s.settings?.[0]?.billing_mode ?? "monthly",
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