// services/walletNotifications.service.js
//
// Sends the "your wallet is blocked, orders are paused" WhatsApp warning
// exactly once per blocked spell, and clears the flag the moment the
// seller is no longer blocked (so the NEXT time they hit zero, they get
// warned again).
//
// IMPORTANT: the actual balance math (accrue/reverse/threshold check) all
// happens INSIDE the Postgres RPCs (wallet_accrue_commission,
// wallet_reverse_commission, wallet_verify_payment) — Node never computes
// the balance itself. The only way to know "did this just cross into
// blocked?" is to re-query wallet_get_status right after any of those RPCs
// returns, which is exactly what this helper does. Call it immediately
// after every `await supabase.rpc(...)` call that can move a seller's
// wallet balance.
//
// ASSUMPTION (please confirm against your actual schema before running
// the migration below): seller_wallets is keyed by seller_id.
import { supabase } from "../config/supabase.js";
import { sendOrderUpdateWhatsApp } from "./whatsapp.service.js";

// Migration (run once):
//   alter table public.seller_wallets
//       add column if not exists low_balance_notified boolean not null default false;

export async function notifyIfWalletJustBlocked({ sellerId, sellerUserId }) {
    if (!sellerId) return;

    const { data: wallet, error } = await supabase.rpc("wallet_get_status", { p_seller_id: sellerId }).single();
    if (error || !wallet) return;

    if (wallet.is_blocked) {
        const { data: walletRow } = await supabase
            .from("seller_wallets").select("low_balance_notified").eq("seller_id", sellerId).maybeSingle();
        if (walletRow?.low_balance_notified) return; // already warned this spell

        if (sellerUserId) {
            const { data: profile } = await supabase
                .from("profiles").select("name, phone").eq("id", sellerUserId).maybeSingle();
            if (profile?.phone) {
                await sendOrderUpdateWhatsApp({
                    to: profile.phone,
                    name: profile.name,
                    headline: "Your wallet balance has reached the limit.",
                    detail: "New orders will be paused on your shop until you recharge.",
                    footer: "Recharge your wallet in the app to start receiving orders again.",
                });
            }
        }
        await supabase.from("seller_wallets").update({ low_balance_notified: true }).eq("seller_id", sellerId);
    } else {
        await supabase.from("seller_wallets").update({ low_balance_notified: false }).eq("seller_id", sellerId);
    }
}