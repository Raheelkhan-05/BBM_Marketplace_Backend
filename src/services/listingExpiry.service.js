// services/listingExpiry.service.js
import { supabaseAdmin } from "../config/supabase.js";
import { notifyUser, notifySellerSubmissionsChanged } from "./notifications.service.js";
import { publishListingChange } from "./listingRealtime.service.js";

const BATCH = 500;
const MAX_BATCHES_PER_RUN = 20;
// Adjust to your real seller listings route.
const SELLER_LISTINGS_PATH = "/seller/listings";

let running = false;

async function publishAll(ids) {
    for (let i = 0; i < ids.length; i += 25) {
        await Promise.allSettled(ids.slice(i, i + 25).map(async (id) => publishListingChange(id)));
    }
}

async function notifySellers(rows) {
    const bySeller = new Map();
    for (const r of rows) {
        if (!bySeller.has(r.out_seller_id)) bySeller.set(r.out_seller_id, []);
        bySeller.get(r.out_seller_id).push(r);
    }
    for (const [sellerId, list] of bySeller) {
        try {
            // Only tell the seller about listings that were actually live (not ones they had paused).
            const liveOnes = list.filter((r) => r.out_was_active);
            if (liveOnes.length) {
                const one = liveOnes.length === 1;
                await notifyUser(sellerId, {
                    type: "listing_expired",
                    title: one ? "A listing has expired" : `${liveOnes.length} listings have expired`,
                    message: one
                        ? `"${liveOnes[0].out_product_name}" has reached the end of its validity and is hidden from buyers. Tap Refresh to take it live again.`
                        : `${liveOnes.length} of your listings reached the end of their validity and are hidden from buyers. Open My Products to refresh them.`,
                    link: `${SELLER_LISTINGS_PATH}?filter=expired`,
                });
            }
            await notifySellerSubmissionsChanged(sellerId);
        } catch (err) {
            console.error("[listingExpiry] notify failed for seller", sellerId, err?.message || err);
        }
    }
}

export async function runListingExpirySweep() {
    if (running) return { skipped: true };
    running = true;
    let total = 0;
    try {
        for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
            const { data, error } = await supabaseAdmin.rpc("expire_due_listings", { p_limit: BATCH });
            if (error) { console.error("[listingExpiry] sweep failed:", error.message); break; }
            const rows = data || [];
            if (!rows.length) break;
            total += rows.length;
            await publishAll(rows.map((r) => r.out_id));
            await notifySellers(rows);
            if (rows.length < BATCH) break;
        }
        return { expired: total };
    } finally {
        running = false;
    }
}

export function startListingExpiryScheduler({ intervalMs = 60_000 } = {}) {
    const tick = () => runListingExpirySweep().catch((e) => console.error("[listingExpiry] tick error:", e?.message || e));
    const first = setTimeout(tick, 5_000);
    const timer = setInterval(tick, intervalMs);
    first.unref?.();
    timer.unref?.();
    return () => { clearTimeout(first); clearInterval(timer); };
}