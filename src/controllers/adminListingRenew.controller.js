// controllers/adminListingRenew.controller.js
// Admin-only. Renew many EXPIRED live listings of one seller in one request.
//
// Each listing is renewed through the same database function the seller's own "Renew" button uses
// (refresh_listing_validity), so the new clock, the expired flag reset and every rule inside that function
// behave exactly like a single renew. Only approved, non-deleted listings that are really expired are touched.
import { supabase, supabaseAdmin } from "../config/supabase.js";
import { validateGSTIN } from "../services/gst.service.js";
import { resolveSellerByGstin } from "../services/stagedListings.service.js";
import { sellerOwnerIds } from "../services/adminSellerKeys.js";
import { publishListingChange } from "../services/listingRealtime.service.js";
import { notifySellerSubmissionsChanged } from "../services/notifications.service.js";
import { isValidValidityHours, resolveValidityHours } from "../../shared/listingValidity.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 300;
const WORKERS = 10;

const gstinOf = (v) => { const c = validateGSTIN(v); return c?.valid ? c.gstin : null; };
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// runs fn over list with a fixed number of parallel workers
async function pool(list, size, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => {
        while (next < list.length) await fn(list[next++]);
    }));
}

// POST /listings/renew { gstin, ids, validityHours? }
// validityHours omitted -> every listing keeps its own saved validity (same rule as the single Renew button).
export async function renewListingsBulk(req, res) {
    const gstin = gstinOf(req.body?.gstin);
    if (!gstin) return res.status(400).json({ success: false, message: "Invalid GSTIN." });

    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).filter((x) => UUID_RE.test(String(x))))];
    if (!ids.length || ids.length > MAX_IDS) return res.status(400).json({ success: false, message: `Select between 1 and ${MAX_IDS} listings at a time.` });

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

        // only listings that are approved, not removed and really expired
        const nowIso = new Date().toISOString();
        const rows = [];
        for (const c of chunks(ids, 100)) {
            const { data, error } = await supabase.from("seller_product_submissions")
                .select("id, seller_id, validity_hours")
                .in("seller_id", owners).in("id", c)
                .is("deleted_at", null).eq("review_status", "approved")
                .or(`expired_at.not.is.null,expires_at.lte.${nowIso}`);
            if (error) throw error;
            rows.push(...(data || []));
        }
        if (!rows.length) {
            return res.status(404).json({ success: false, message: "None of these listings are expired any more. Refresh the page and try again." });
        }

        const items = [];
        let failed = 0;
        await pool(rows, WORKERS, async (row) => {
            const { data, error } = await supabaseAdmin.rpc("refresh_listing_validity", {
                p_submission_id: row.id,
                p_seller_id: row.seller_id,
                p_validity_hours: override ?? resolveValidityHours(row.validity_hours),
            });
            const out = Array.isArray(data) ? data[0] : data;
            if (error || !out) {
                failed += 1;
                if (error) console.error("[adminListingRenew] refresh failed:", row.id, error.message);
                return;
            }
            items.push({
                id: out.out_id, is_active: out.out_is_active, validity_hours: out.out_validity_hours,
                valid_from: out.out_valid_from, expires_at: out.out_expires_at, expired_at: out.out_expired_at,
            });
        });

        if (!items.length) return res.status(500).json({ success: false, message: "Could not renew these listings. Please try again." });

        // live updates for buyers and the seller's own pages (best effort)
        for (const it of items) {
            try { Promise.resolve(publishListingChange(it.id)).catch(() => { }); }
            catch (e) { console.error("[adminListingRenew] realtime:", e?.message || e); }
        }
        try {
            for (const id of new Set(rows.map((x) => x.seller_id))) await notifySellerSubmissionsChanged(id);
        } catch { /* best effort */ }

        res.json({ success: true, renewed: items.length, failed, skipped: ids.length - rows.length, items });
    } catch (e) {
        console.error("[adminListingRenew] renew:", e?.message || e);
        return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
    }
}