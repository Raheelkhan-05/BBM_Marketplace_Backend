// controllers/adminListingBulk.controller.js
// Admin-only. Bulk remove: unfinished drafts (hard delete), waiting list (hard delete),
// live seller listings (SOFT delete: the row is kept, marked deleted, hidden everywhere).
import { supabase } from "../config/supabase.js";
import { validateGSTIN } from "../services/gst.service.js";
import { resolveSellerByGstin } from "../services/stagedListings.service.js";
import { sellerOwnerIds } from "../services/adminSellerKeys.js";
import { publishListingRemoved } from "../services/listingRealtime.service.js";
import { notifySellerSubmissionsChanged, notifyAdminSubmissionsChanged } from "../services/notifications.service.js";
// Same exact reason every seller-facing query already hides (see listMySubmissions, getSubmissionDetail, ...).
import { CATALOG_REMOVED_REJECTION_REASON } from "./sellerCatalogListings.controller.js";
import { genericProductUsable } from "../services/catalogMapping.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 300;

const gstinOf = (v) => { const c = validateGSTIN(v); return c?.valid ? c.gstin : null; };
const fail = (res, e, label) => {
    console.error(`[adminListingBulk] ${label}:`, e?.message || e);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
};
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

function parse(req) {
    const gstin = gstinOf(req.body?.gstin);
    if (!gstin) return { error: "Invalid GSTIN." };
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).filter((x) => UUID_RE.test(String(x))))];
    if (!ids.length || ids.length > MAX_IDS) return { error: `Select between 1 and ${MAX_IDS} products at a time.` };
    return { gstin, ids };
}


// POST /staged/map { gstin, ids, parentId }  -- parentId null clears the mapping. Waiting/Failed rows only.
export async function setStagedMapping(req, res) {
    const p = parse(req);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    const parentId = req.body?.parentId ?? null;
    if (parentId !== null && !UUID_RE.test(String(parentId))) return res.status(400).json({ success: false, message: "Pick a generic product." });
    try {
        if (parentId && !(await genericProductUsable(parentId))) return res.status(400).json({ success: false, message: "Selected generic product wasn't found." });
        const done = [];
        for (const c of chunks(p.ids, 100)) {
            const { data, error } = await supabase.from("admin_staged_listings")
                .update({ map_parent_id: parentId, updated_at: new Date().toISOString() })
                .eq("gstin", p.gstin).in("status", ["staged", "failed"]).in("id", c).select("id");
            if (error) throw error;
            done.push(...(data || []).map((r) => r.id));
        }
        res.json({ success: true, updated: done.length, skipped: p.ids.length - done.length, ids: done });
    } catch (e) { return fail(res, e, "map staged"); }
}

// POST /drafts/delete { gstin, ids } -- unfinished bulk-upload products
export async function deleteDraftsBulk(req, res) {
    const p = parse(req);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    try {
        const gone = [];
        for (const c of chunks(p.ids, 100)) {
            const { data, error } = await supabase.from("admin_listing_drafts").delete()
                .eq("gstin", p.gstin).in("id", c).select("id");
            if (error) throw error;
            gone.push(...(data || []).map((r) => r.id));
        }
        res.json({ success: true, deleted: gone.length, ids: gone });
    } catch (e) { return fail(res, e, "delete drafts"); }
}

// POST /staged/delete { gstin, ids } -- waiting list (only items that are not being published / already live)
export async function deleteStagedBulk(req, res) {
    const p = parse(req);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    try {
        const gone = [];
        for (const c of chunks(p.ids, 100)) {
            const { data, error } = await supabase.from("admin_staged_listings").delete()
                .eq("gstin", p.gstin).in("status", ["staged", "failed"]).in("id", c).select("id");
            if (error) throw error;
            gone.push(...(data || []).map((r) => r.id));
        }
        res.json({ success: true, deleted: gone.length, ids: gone });
    } catch (e) { return fail(res, e, "delete staged"); }
}

// POST /listings/delete { gstin, ids } -- live seller listings. SOFT delete, nothing is erased.
// The row is marked deleted, set inactive and rejected with the catalog-removed reason, which every existing
// query already hides from the seller and from buyers (home, search, shop page, ordering all need approved + active).
// Orders already placed keep their own snapshot and are not touched.
export async function softDeleteListings(req, res) {
    const p = parse(req);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    try {
        const r = await resolveSellerByGstin(p.gstin);
        if (r.kind !== "live") return res.status(409).json({ success: false, code: "NOT_A_LIVE_SELLER", message: "This business is not an approved seller yet." });

        const owners = await sellerOwnerIds(r);
        if (!owners.length) return res.status(409).json({ success: false, message: "Could not identify this seller." });

        const now = new Date().toISOString();
        const rows = [];
        for (const c of chunks(p.ids, 100)) {
            const { data, error } = await supabase.from("seller_product_submissions")
                .update({
                    deleted_at: now, deleted_by: req.user.id,
                    is_active: false,
                    review_status: "rejected", rejection_reason: CATALOG_REMOVED_REJECTION_REASON,
                    reviewed_at: now, reviewed_by: req.user.id,
                })
                .in("seller_id", owners).is("deleted_at", null).in("id", c)
                .select("id, seller_id, generic_product_brand_id");
            if (error) throw error;
            rows.push(...(data || []));
        }

        if (!rows.length) {
            // Nothing matched. Say why instead of reporting a silent success.
            const { count } = await supabase.from("seller_product_submissions")
                .select("id", { count: "exact", head: true }).in("id", p.ids).not("deleted_at", "is", null);
            return res.status(404).json({
                success: false,
                message: count ? "These listings were already removed." : "These listings were not found for this seller. Refresh the page and try again.",
            });
        }

        for (const row of rows) {
            try { publishListingRemoved({ submissionId: row.id, brandItemId: row.generic_product_brand_id, sellerId: row.seller_id }); }
            catch (e) { console.error("[adminListingBulk] realtime:", e?.message || e); }
        }
        try {
            for (const id of new Set(rows.map((x) => x.seller_id))) await notifySellerSubmissionsChanged(id);
            await notifyAdminSubmissionsChanged();
        } catch { /* best effort */ }

        res.json({ success: true, deleted: rows.length, skipped: p.ids.length - rows.length, ids: rows.map((x) => x.id) });
    } catch (e) { return fail(res, e, "soft delete listings"); }
}