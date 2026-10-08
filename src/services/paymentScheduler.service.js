// src/services/paymentScheduler.service.js
//
// Every minute: re-check payments that are still open (buyer left mid-payment, webhook delayed),
// repair any missing commission accrual, enqueue refunds for new refund ledger rows, and
// push queued refunds to JioPay. Safe with several instances (everything claims rows with
// FOR UPDATE SKIP LOCKED) and never overlaps itself within one process.
//
// NOTE (Render): this only runs while the instance is awake. Use an always-on instance for
// production payments; a sleeping free instance will also miss/slow webhooks.
import { reconcileTick } from "./payments.service.js";
import { logJiopayConfigStatus } from "../config/jiopay.js";

const INTERVAL_MS = 60 * 1000;
let running = false;

async function tick() {
    if (running) return;
    running = true;
    try {
        await reconcileTick();
    } catch (e) {
        console.error("[payments] reconcile tick failed:", e?.message || e);
    } finally {
        running = false;
    }
}

export function startPaymentScheduler() {
    if (!logJiopayConfigStatus()) {
        console.warn("[payments] JioPay is not fully configured — payment scheduler not started.");
        return null;
    }
    tick();
    const timer = setInterval(tick, INTERVAL_MS);
    timer.unref?.();
    return timer;
}