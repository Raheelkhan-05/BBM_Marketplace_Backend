// controllers/adminListingImages.controller.js
// Admin-only. Apply the same photos to many listings of one seller (live listings, staged listings, bulk drafts).
import { supabase } from "../config/supabase.js";
import { validateGSTIN } from "../services/gst.service.js";
import { resolveSellerByGstin } from "../services/stagedListings.service.js";
import { sellerOwnerIds } from "../services/adminSellerKeys.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 300, MAX_IMAGES = 5;

const gstinOf = (v) => { const c = validateGSTIN(v); return c?.valid ? c.gstin : null; };
const fail = (res, e, label) => {
    console.error(`[adminListingImages] ${label}:`, e?.message || e);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
};
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const inBatches = async (list, size, fn) => { for (const c of chunks(list, size)) await Promise.all(c.map(fn)); };

function parse(req) {
    const gstin = gstinOf(req.body?.gstin);
    if (!gstin) return { error: "Invalid GSTIN." };
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).filter((x) => UUID_RE.test(String(x))))];
    if (!ids.length || ids.length > MAX_IDS) return { error: `Select between 1 and ${MAX_IDS} products at a time.` };
    const images = [...new Set((Array.isArray(req.body?.images) ? req.body.images : [])
        .map((u) => (typeof u === "string" ? u.trim() : "")).filter((u) => /^https?:\/\//i.test(u) && u.length <= 2000))];
    if (!images.length || images.length > MAX_IMAGES) return { error: `Add between 1 and ${MAX_IMAGES} photos.` };
    return { gstin, ids, images, mode: req.body?.mode === "replace" ? "replace" : "add" };
}

// "replace" -> exactly the new photos. "add" -> existing photos first, then the new ones, max 5 (cover stays first).
const merge = (current, add, mode) => {
    const base = mode === "replace" ? [] : (Array.isArray(current) ? current.filter((u) => typeof u === "string" && u) : []);
    return [...new Set([...base, ...add])].slice(0, MAX_IMAGES);
};

// POST /listings/images { gstin, ids, images, mode }  -- live seller submissions
export async function setListingImages(req, res) {
    const p = parse(req);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    try {
        const r = await resolveSellerByGstin(p.gstin);
        if (r.kind !== "live") return res.status(409).json({ success: false, code: "NOT_A_LIVE_SELLER", message: "This business is not an approved seller yet." });

        const owners = await sellerOwnerIds(r);
        if (!owners.length) return res.status(409).json({ success: false, message: "Could not identify this seller." });

        const rows = [];
        for (const c of chunks(p.ids, 100)) {
            const { data, error } = await supabase.from("seller_product_submissions")
                .select("id, image, images").in("seller_id", owners).is("deleted_at", null).in("id", c);
            if (error) throw error;
            rows.push(...(data || []));
        }
        if (!rows.length) return res.status(404).json({ success: false, message: "These listings were not found for this seller. Refresh the page and try again." });

        // rows that end up with the same photos are updated together in one query
        const groups = new Map();
        const items = [];
        for (const row of rows) {
            const current = Array.isArray(row.images) && row.images.length ? row.images : (row.image ? [row.image] : []);
            const next = merge(current, p.images, p.mode);
            items.push({ id: row.id, images: next });
            const key = JSON.stringify(next);
            if (!groups.has(key)) groups.set(key, { next, ids: [] });
            groups.get(key).ids.push(row.id);
        }
        for (const g of groups.values()) {
            for (const c of chunks(g.ids, 100)) {
                const { error } = await supabase.from("seller_product_submissions")
                    .update({ images: g.next, image: g.next[0] || null }).in("seller_id", owners).in("id", c);
                if (error) throw error;
            }
        }
        res.json({ success: true, updated: rows.length, skipped: p.ids.length - rows.length, items });
    } catch (e) { return fail(res, e, "listing images"); }
}

// POST /staged/images { gstin, ids, images, mode }  -- products waiting for seller setup
export async function setStagedImages(req, res) {
    const p = parse(req);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    try {
        const rows = [];
        for (const c of chunks(p.ids, 50)) {
            const { data, error } = await supabase.from("admin_staged_listings").select("id, status, payload").eq("gstin", p.gstin).in("id", c);
            if (error) throw error;
            rows.push(...(data || []));
        }
        const eligible = rows.filter((x) => ["staged", "failed"].includes(x.status));
        const items = [];
        let failed = 0;
        await inBatches(eligible, 10, async (row) => {
            const next = merge(row.payload?.images, p.images, p.mode);
            const { error } = await supabase.from("admin_staged_listings")
                .update({ payload: { ...(row.payload || {}), images: next }, image: next[0] || null })
                .eq("id", row.id).in("status", ["staged", "failed"]);
            if (error) { failed += 1; console.error("[adminListingImages] staged update:", error.message); } else items.push({ id: row.id, images: next });
        });
        if (failed && !items.length) return res.status(500).json({ success: false, message: "Could not update the photos. Please try again." });
        res.json({ success: true, updated: items.length, skipped: p.ids.length - items.length, items });
    } catch (e) { return fail(res, e, "staged images"); }
}

// POST /drafts/images { gstin, ids, images, mode }  -- unfinished bulk-upload products
export async function setDraftImages(req, res) {
    const p = parse(req);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    try {
        const rows = [];
        for (const c of chunks(p.ids, 50)) {
            const { data, error } = await supabase.from("admin_listing_drafts").select("id, data").eq("gstin", p.gstin).in("id", c);
            if (error) throw error;
            rows.push(...(data || []));
        }
        const items = [];
        let failed = 0;
        await inBatches(rows, 10, async (row) => {
            const base = row.data && typeof row.data === "object" ? row.data : {};
            const next = merge(base.im, p.images, p.mode);
            const { error } = await supabase.from("admin_listing_drafts").update({ data: { ...base, im: next }, updated_at: new Date().toISOString() }).eq("id", row.id);
            if (error) { failed += 1; console.error("[adminListingImages] draft update:", error.message); } else items.push({ id: row.id, im: next });
        });
        if (failed && !items.length) return res.status(500).json({ success: false, message: "Could not update the photos. Please try again." });
        res.json({ success: true, updated: items.length, skipped: p.ids.length - items.length, items });
    } catch (e) { return fail(res, e, "draft images"); }
}