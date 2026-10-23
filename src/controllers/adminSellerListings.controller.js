// Admin-only. Create / manage product listings on behalf of a seller, identified by GSTIN.
import jwt from "jsonwebtoken";
import { supabase } from "../config/supabase.js";
import { validateGSTIN, fetchGstinDetails } from "../services/gst.service.js";
import { resolveSellerByGstin, publishQueuedForGstin } from "../services/stagedListings.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_HOURS = 4;
const MAX_DRAFTS = 500, MAX_CHUNK = 50, MAX_ITEM_CHARS = 60000, MAX_PAYLOAD_CHARS = 200000;
const DRAFT_COLS = "id, batch_id, file_name, row_no, data, created_at";

const gstinOf = (v) => { const c = validateGSTIN(v); return c?.valid ? c.gstin : null; };
const fail = (res, e, label) => {
    console.error(`[adminSellerListings] ${label}:`, e?.message || e);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
};
const validData = (d, max) => d && typeof d === "object" && !Array.isArray(d) && JSON.stringify(d).length <= max;

async function stagedCounts(gstin) {
    const { data } = await supabase.from("admin_staged_listings").select("status").eq("gstin", gstin).limit(5000);
    const c = { staged: 0, publishing: 0, failed: 0, published: 0, skipped: 0 };
    (data || []).forEach((r) => { c[r.status] = (c[r.status] || 0) + 1; });
    return c;
}

// GET /lookup?gstin=
export async function lookupSeller(req, res) {
    const gstin = gstinOf(req.query.gstin);
    if (!gstin) return res.status(400).json({ success: false, message: "Enter a valid 15-character GSTIN." });
    try {
        const r = await resolveSellerByGstin(gstin);
        const b = r.business || null;
        let name = b?.display_name || b?.trade_name || b?.legal_name || null;
        let details = b ? { legalName: b.legal_name, tradeName: b.trade_name, address: b.registered_address, pincode: b.pincode, district: b.district, state: b.state } : null;
        let verified = true, note = null;

        if (r.kind === "no_account") { // not on BBM: confirm the GSTIN is real so products are never tied to a typo
            try {
                const g = await fetchGstinDetails(gstin);
                if (g?.mapped) {
                    const m = g.mapped;
                    name = m.trade_name || m.legal_name || null;
                    details = { legalName: m.legal_name, tradeName: m.trade_name, address: m.registered_address, pincode: m.pincode, district: m.district, state: m.state };
                    if (m.gstin_status && m.gstin_status !== "Active") note = `GST status: ${m.gstin_status}.`;
                } else { verified = false; note = g?.reason || "Could not verify this GSTIN."; }
            } catch { verified = false; note = "The GST service did not respond."; }
        }
        res.json({
            success: true, gstin, state: r.kind, businessName: name, details, verified, note,
            shopSlug: r.seller?.shop_slug || null, queue: await stagedCounts(gstin),
        });
    } catch (e) { return fail(res, e, "lookup"); }
}

// POST /session { gstin }  -> short-lived "act as this seller" token
export async function createSellerSession(req, res) {
    const gstin = gstinOf(req.body?.gstin);
    if (!gstin) return res.status(400).json({ success: false, message: "Invalid GSTIN." });
    if (!process.env.AUTH_JWT_SECRET) return fail(res, new Error("AUTH_JWT_SECRET missing"), "session");
    try {
        const r = await resolveSellerByGstin(gstin);
        if (r.kind !== "live") return res.status(409).json({ success: false, code: "NOT_A_LIVE_SELLER", message: "This business is not an approved seller yet." });
        const token = jwt.sign({ sub: r.userId, imp: true, act: req.user.id }, process.env.AUTH_JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
        const { error } = await supabase.from("admin_seller_sessions").insert({ admin_id: req.user.id, seller_id: r.userId, gstin });
        if (error) console.error("[adminSellerListings] audit insert failed:", error.message);
        res.json({ success: true, token, expiresAt: Date.now() + SESSION_HOURS * 3600 * 1000 });
    } catch (e) { return fail(res, e, "session"); }
}

// POST /staged { gstin, payload }  -- for sellers that are not live yet
export async function stageListing(req, res) {
    const gstin = gstinOf(req.body?.gstin);
    const payload = req.body?.payload;
    if (!gstin) return res.status(400).json({ success: false, message: "Invalid GSTIN." });
    if (!validData(payload, MAX_PAYLOAD_CHARS)) return res.status(400).json({ success: false, message: "Invalid product." });
    const name = String(payload.productName || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "Product name is required." });
    if (!payload.brandNotApplicable && !String(payload.brandName || "").trim()) return res.status(400).json({ success: false, message: "Brand is required." });
    if (!Array.isArray(payload.images) || !payload.images.length) return res.status(400).json({ success: false, message: "Add at least one photo." });
    delete payload.rfqEnquiryId; delete payload.marketingCommissionPercent;

    try {
        const r = await resolveSellerByGstin(gstin);
        if (r.kind === "live") return res.status(409).json({ success: false, code: "SELLER_IS_LIVE", message: "This seller is already live. Add the product directly." });
        const { data, error } = await supabase.from("admin_staged_listings").insert({
            gstin, payload, product_name: name,
            brand_name: payload.brandNotApplicable ? null : String(payload.brandName).trim(),
            image: payload.images[0] || null, created_by: req.user.id,
        }).select("id").single();
        if (error) {
            if (error.code === "23505") return res.status(409).json({ success: false, message: "This product is already waiting for this GSTIN." });
            throw error;
        }
        res.json({ success: true, id: data.id, staged: true, message: "Saved. It goes live automatically once this business finishes seller setup." });
    } catch (e) { return fail(res, e, "stage"); }
}

// GET /staged?gstin=
export async function listStaged(req, res) {
    const gstin = gstinOf(req.query.gstin);
    if (!gstin) return res.status(400).json({ success: false, message: "Invalid GSTIN." });
    const { data, error } = await supabase.from("admin_staged_listings")
        .select("id, product_name, brand_name, image, status, error, submission_id, created_at, published_at, map_parent_id, map_parent:hs_generic_products(id, name)")
        .eq("gstin", gstin).order("created_at", { ascending: false }).limit(500);
    if (error) return fail(res, error, "list staged");
    res.json({ success: true, items: data || [] });
}

// DELETE /staged/:id
export async function deleteStaged(req, res) {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ success: false, message: "Invalid item." });
    const { data, error } = await supabase.from("admin_staged_listings").delete()
        .eq("id", req.params.id).neq("status", "publishing").select("id").maybeSingle();
    if (error) return fail(res, error, "delete staged");
    if (!data) return res.status(404).json({ success: false, message: "Not found, or it is being published right now." });
    res.json({ success: true });
}

// POST /staged/publish { gstin }
export async function publishStagedNow(req, res) {
    const gstin = gstinOf(req.body?.gstin);
    if (!gstin) return res.status(400).json({ success: false, message: "Invalid GSTIN." });
    try {
        const out = await publishQueuedForGstin(gstin);
        if (out.waiting) return res.status(409).json({ success: false, message: "This business is not an approved seller yet." });
        res.json({ success: true, ...out });
    } catch (e) { return fail(res, e, "publish"); }
}

/* ---------------- bulk drafts (admin-owned, per GSTIN) ---------------- */
const mapDraft = (r) => ({ ...r, status: "pending" });

export async function listDrafts(req, res) {
    const gstin = gstinOf(req.query.gstin);
    if (!gstin) return res.status(400).json({ success: false, message: "Invalid GSTIN." });
    const { data, error } = await supabase.from("admin_listing_drafts").select(DRAFT_COLS)
        .eq("gstin", gstin).order("created_at", { ascending: true }).order("row_no", { ascending: true }).limit(MAX_DRAFTS);
    if (error) return fail(res, error, "list drafts");
    res.json({ success: true, items: (data || []).map(mapDraft) });
}

export async function createDrafts(req, res) {
    const { batchId, fileName, items } = req.body || {};
    const gstin = gstinOf(req.body?.gstin);
    if (!gstin) return res.status(400).json({ success: false, message: "Invalid GSTIN." });
    if (!UUID_RE.test(String(batchId || ""))) return res.status(400).json({ success: false, message: "Invalid batch." });
    if (!Array.isArray(items) || !items.length || items.length > MAX_CHUNK) return res.status(400).json({ success: false, message: `Send between 1 and ${MAX_CHUNK} products at a time.` });
    for (const it of items) {
        if (!Number.isInteger(it?.rowNo) || it.rowNo < 1 || !validData(it.data, MAX_ITEM_CHARS)) return res.status(400).json({ success: false, message: "One of the products is invalid or too large." });
    }
    const { count, error: cErr } = await supabase.from("admin_listing_drafts").select("id", { count: "exact", head: true }).eq("gstin", gstin);
    if (cErr) return fail(res, cErr, "count drafts");
    if ((count || 0) + items.length > MAX_DRAFTS) return res.status(400).json({ success: false, message: `At most ${MAX_DRAFTS} unfinished products per GSTIN. Submit or discard some first.` });

    const rows = items.map((it) => ({ gstin, batch_id: batchId, file_name: String(fileName || "").slice(0, 200) || null, row_no: it.rowNo, data: it.data, created_by: req.user.id }));
    const { error } = await supabase.from("admin_listing_drafts").upsert(rows, { onConflict: "batch_id,row_no", ignoreDuplicates: true });
    if (error) return fail(res, error, "create drafts");
    const { data, error: sErr } = await supabase.from("admin_listing_drafts").select(DRAFT_COLS)
        .eq("gstin", gstin).eq("batch_id", batchId).in("row_no", items.map((i) => i.rowNo)).order("row_no", { ascending: true });
    if (sErr) return fail(res, sErr, "read drafts");
    res.json({ success: true, items: (data || []).map(mapDraft) });
}

export async function updateDraft(req, res) {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ success: false, message: "Invalid item." });
    if (!validData(req.body?.data, MAX_ITEM_CHARS)) return res.status(400).json({ success: false, message: "Invalid or too large." });
    const { data, error } = await supabase.from("admin_listing_drafts")
        .update({ data: req.body.data, updated_at: new Date().toISOString() }).eq("id", req.params.id).select("id").maybeSingle();
    if (error) return fail(res, error, "update draft");
    if (!data) return res.status(404).json({ success: false, message: "Item not found." });
    res.json({ success: true });
}

export async function deleteDraft(req, res) {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ success: false, message: "Invalid item." });
    const { error } = await supabase.from("admin_listing_drafts").delete().eq("id", req.params.id);
    if (error) return fail(res, error, "delete draft");
    res.json({ success: true });
}

export async function clearDrafts(req, res) {
    const gstin = gstinOf(req.query.gstin);
    if (!gstin) return res.status(400).json({ success: false, message: "Invalid GSTIN." });
    const { error } = await supabase.from("admin_listing_drafts").delete().eq("gstin", gstin);
    if (error) return fail(res, error, "clear drafts");
    res.json({ success: true });
}