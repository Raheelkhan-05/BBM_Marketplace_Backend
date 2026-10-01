// services/orderExpiry.service.js
//
// Auto-marks orders "not accepted" when the seller hasn't accepted within the
// response window (24h, see seller_response_hours() in SQL), refunds the buyer
// (dummy ledger entry) and notifies both sides.
//
// All state changes happen in ONE atomic SQL function, expire_unaccepted_orders(),
// which is safe to run from several instances at once (SKIP LOCKED). This file
// only does the side effects that can't live in SQL: wallet fee reversal,
// notifications and WhatsApp. A failed notification never undoes the expiry.
//
// Started from startSettlementScheduler() (settlement.service.js), so no
// server.js change is needed.
import { supabase } from "../config/supabase.js";
import { notifyUser, notifyOrderChanged, notifyUserOrdersChanged } from "./realtimeBroadcast.js";
import { sendOrderUpdateWhatsApp } from "./whatsapp.service.js";
import { notifyIfWalletJustBlocked } from "./walletNotifications.service.js";

const SWEEP_INTERVAL_MS = 60 * 1000;
const BATCH_SIZE = 100;
let running = false;

const inr = (n) => `₹${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

async function safely(label, fn) {
    try { await fn(); } catch (e) { console.error(`[orderExpiry] ${label} failed:`, e?.message || e); }
}

async function runSideEffects(r) {
    const refund = Number(r.r_refund) || 0;

    // The seller's Promotion & Visibility fee was accrued when the order arrived; give it back
    // (same as a manual rejection).
    await safely("wallet reverse", async () => {
        await supabase.rpc("wallet_reverse_commission", { p_order_id: r.r_order_id });
        if (r.r_seller_user_id) {
            await notifyIfWalletJustBlocked({ sellerId: r.r_seller_id, sellerUserId: r.r_seller_user_id });
        }
    });

    await safely("realtime", () => notifyOrderChanged(r.r_order_id, { status: "rejected" }));

    await safely("buyer notification", async () => {
        await notifyUser(r.r_buyer_id, {
            type: "order_not_accepted",
            title: `Order ${r.r_order_number} not accepted`,
            body: refund > 0
                ? `The seller didn't accept your order in time, so it was cancelled. A full refund of ${inr(refund)} has been initiated (ref ${r.r_reference}).`
                : "The seller didn't accept your order in time, so it was cancelled. You haven't been charged.",
            link: `/orders/${r.r_order_id}`,
        });
        await notifyUserOrdersChanged(r.r_buyer_id);
    });

    await safely("seller notification", async () => {
        if (!r.r_seller_user_id) return;
        await notifyUser(r.r_seller_user_id, {
            type: "order_not_accepted",
            title: `Order ${r.r_order_number} expired`,
            body: "You didn't accept this order in time, so it was marked as not accepted and the buyer has been refunded.",
            link: `/seller/orders/${r.r_order_id}`,
        });
        await notifyUserOrdersChanged(r.r_seller_user_id);
    });

    await safely("whatsapp", async () => {
        if (!r.r_buyer_phone) return;
        await sendOrderUpdateWhatsApp({
            to: r.r_buyer_phone,
            name: r.r_buyer_name,
            headline: `Your order #${r.r_order_number} was not accepted by the seller in time.`,
            detail: refund > 0
                ? `A full refund of ${inr(refund)} has been initiated.`
                : "The order has been cancelled and you have not been charged.",
            footer: "You can place the order again or choose another seller.",
        });
    });
}

export async function expireUnacceptedOrders() {
    const { data, error } = await supabase.rpc("expire_unaccepted_orders", { p_limit: BATCH_SIZE });
    if (error) throw new Error(error.message);
    const expired = data || [];
    for (const r of expired) await runSideEffects(r);
    return expired;
}

async function tick() {
    if (running) return; // never overlap sweeps within one process
    running = true;
    try {
        let batch;
        do {
            batch = await expireUnacceptedOrders();
        } while (batch.length === BATCH_SIZE); // drain a backlog
    } catch (e) {
        console.error("[orderExpiry] sweep failed:", e?.message || e);
    } finally {
        running = false;
    }
}

export function startOrderExpiryScheduler() {
    tick(); // catch up immediately after a restart / downtime
    const timer = setInterval(tick, SWEEP_INTERVAL_MS);
    timer.unref?.();
    return timer;
}