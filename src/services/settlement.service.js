// services/settlement.service.js
//
// Releases held seller payouts once the dispute window has elapsed with no
// dispute. The actual work (lock rows, write the DUMMY ledger entry, flip
// settlement_status) is one atomic SQL function — settlement_release_due() —
// which is safe to call from several instances at once (SKIP LOCKED).
//
// Wire-up: call startSettlementScheduler() once after the HTTP server starts
// (see server.js note in the hand-off). When a real bank API exists, add the
// API call where the comment says so — the ledger rows stay as the audit trail.
import { supabase } from "../config/supabase.js";
import { notifyUser, notifyOrderChanged, notifyUserOrdersChanged } from "./realtimeBroadcast.js";

const SWEEP_INTERVAL_MS = 60 * 1000;
const BATCH_SIZE = 100;
let running = false;

const inr = (n) => `₹${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export async function releaseDueSettlements() {
    const { data, error } = await supabase.rpc("settlement_release_due", { p_limit: BATCH_SIZE });
    if (error) throw new Error(error.message);
    const released = data || [];

    for (const r of released) {
        // TODO(real payouts): trigger the bank transfer for r.r_amount here, using r.r_reference as the idempotency key.
        try {
            await notifyOrderChanged(r.r_order_id, { status: "delivered", settlement: "released" });
            if (r.r_seller_user_id) {
                await notifyUser(r.r_seller_user_id, {
                    type: "payout_released",
                    title: `Payout released for order ${r.r_order_number}`,
                    body: `${inr(r.r_amount)} has been sent to your bank account (ref ${r.r_reference}).`,
                    link: `/seller/orders/${r.r_order_id}`,
                });
                await notifyUserOrdersChanged(r.r_seller_user_id);
            }
        } catch (e) {
            // The payout itself is already committed; a failed notification must never undo or block it.
            console.error("[settlement] notify failed for", r.r_order_id, e?.message || e);
        }
    }
    return released;
}

async function tick() {
    if (running) return; // never overlap sweeps within one process
    running = true;
    try {
        let batch;
        do {
            batch = await releaseDueSettlements();
        } while (batch.length === BATCH_SIZE); // drain a backlog
    } catch (e) {
        console.error("[settlement] sweep failed:", e?.message || e);
    } finally {
        running = false;
    }
}

export function startSettlementScheduler() {
    tick(); // catch up immediately after a restart / downtime
    const timer = setInterval(tick, SWEEP_INTERVAL_MS);
    timer.unref?.();
    return timer;
}