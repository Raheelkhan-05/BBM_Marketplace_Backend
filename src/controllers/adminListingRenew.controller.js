// controllers/adminListingRenew.controller.js
// Admin-only. Renew EXPIRED live listings of one seller with a single database statement.
//
// The SQL function admin_bulk_refresh_listings applies the same rules as the seller's own Renew
// (refresh_listing_validity: new clock, expired flag cleared, listing active) to every expired listing at once,
// so 1000+ listings take about a second. Only approved, non-deleted, really expired listings are touched.
// Realtime pushes and notifications run AFTER the response, so the admin never waits for them.
import { supabaseAdmin } from "../config/supabase.js";
import { validateGSTIN } from "../services/gst.service.js";
import { resolveSellerByGstin } from "../services/stagedListings.service.js";
import { sellerOwnerIds } from "../services/adminSellerKeys.js";
import { publishListingChange } from "../services/listingRealtime.service.js";
import { notifySellerSubmissionsChanged } from "../services/notifications.service.js";
import { isValidValidityHours } from "../../shared/listingValidity.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 1000;
const WORKERS = 10;

const gstinOf = (v) => { const c = validateGSTIN(v); return c?.valid ? c.gstin : null; };

async function pool(list, size, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => {
        while (next < list.length) await fn(list[next++]);
    }));
}

// POST /listings/renew { gstin, all?: true, ids?: [...], validityHours? }
//   all: true   -> every expired listing of this seller (no ids needed)
//   ids         -> only those listings, and only if they are expired (max 1000 per request)
//   validityHours omitted -> every listing keeps its own saved validity
export async function renewListingsBulk(req, res) {
    const gstin = gstinOf(req.body?.gstin);
    if (!gstin) return res.status(400).json({ success: false, message: "Invalid GSTIN." });

    const all = req.body?.all === true;
    let ids = null;
    if (!all) {
        ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).filter((x) => UUID_RE.test(String(x))))];
        if (!ids.length || ids.length > MAX_IDS) return res.status(400).json({ success: false, message: `Select between 1 and ${MAX_IDS} listings at a time.` });
    }

    const rawHours = req.body?.validityHours;
    let override = null;
    if (rawHours !== undefined && rawHours !== null && rawHours !== "") {
        if (!isValidValidityHours(rawHours)) return res.status(400).json({ success: false, message: "Please choose a valid listing validity." });
        override = Number(rawHours);
    }

    try {
        const r = await resolveSellerByGstin(gstin);
        if (r.kind !== "live") return res.status(409).json({ success: false, code: "NOT_A_LIVE_SELLER", message: "This business is not an approved seller yet." });

        const owners = await sellerOwnerIds(r);
        if (!owners.length) return res.status(409).json({ success: false, message: "Could not identify this seller." });

        const { data, error } = await supabaseAdmin.rpc("admin_bulk_refresh_listings", {
            p_owner_ids: owners, p_ids: ids, p_validity_hours: override,
        });
        if (error) throw error;

        const renewed = Number(data?.renewed) || 0;
        if (!renewed) {
            return res.status(404).json({ success: false, message: "None of these listings are expired any more. Refresh the page and try again." });
        }
        const items = (data.items || []).map((x) => ({ id: x.id, validity_hours: x.h, expires_at: x.e }));

        res.json({
            success: true, renewed, skipped: ids ? ids.length - renewed : 0,
            valid_from: data.valid_from, items,
        });

        // after the response: live updates for buyers and the seller's own pages (best effort)
        setImmediate(async () => {
            try {
                await pool(items, WORKERS, async (it) => {
                    try { await publishListingChange(it.id); } catch (e) { console.error("[adminListingRenew] realtime:", e?.message || e); }
                });
                for (const id of data.seller_ids || []) await notifySellerSubmissionsChanged(id);
            } catch (e) { console.error("[adminListingRenew] after-renew:", e?.message || e); }
        });
    } catch (e) {
        console.error("[adminListingRenew] renew:", e?.message || e);
        return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
    }
}