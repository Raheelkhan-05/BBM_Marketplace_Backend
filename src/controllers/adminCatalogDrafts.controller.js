// controllers/adminCatalogDrafts.controller.js
// Admin-only. Catalog bulk upload with a review screen. No category path is needed.
//   - drafts: unfinished products, saved per admin (admin_catalog_drafts)
//   - check:  read-only lookup of which name + brand pairs already exist in the catalog
//   - submit: inserts the products into hs_generic_product_brands as approved and UNMAPPED
//             (generic_product_id = null), exactly like seller-created products. They show under "Needs mapping".
// Identity of a product = lower(btrim(name)) + lower(btrim(brand_name)) among non-deleted rows (index hs_gpb_identity_uq).
import { supabase } from "../config/supabase.js";
import { slugify } from "../services/slugify.js";
import { ALLOWED_UNITS } from "./sellerCatalogListings.controller.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DRAFTS = 2000, MAX_CHUNK = 50, MAX_ITEM_CHARS = 30000, MAX_IDS = 300;
const MAX_SUBMIT = 50, MAX_CHECK = 200, MAX_ROWS = 1000, MAX_PHOTOS = 8;
const DRAFT_COLS = "id, batch_id, file_name, row_no, data, created_at";
const PAGE = 1000;
const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28]; // keep in sync with the seller wizard and utils/catalogBulkSchema.js
const ITEM_TABLE = "hs_generic_product_brands";

/* ---------------------------------- helpers ---------------------------------- */
const fail = (res, e, label) => {
    console.error(`[adminCatalogDrafts] ${label}:`, e?.stack || e?.message || e);
    return res.status(500).json({
        success: false,
        message: "Something went wrong. Please try again.",
        detail: e?.message || String(e), // admin-only endpoints: keep failures debuggable
        step: label,
    });
};
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const S = (v, n = 200) => String(v ?? "").slice(0, n);
const norm = (s) => String(s ?? "").trim().toLowerCase();
// ilike treats % and _ as wildcards: escape them so a name is matched literally
const escLike = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
const validData = (d, max) => d && typeof d === "object" && !Array.isArray(d) && JSON.stringify(d).length <= max;
const gstOk = (v) => String(v ?? "").trim() !== "" && GST_RATES.includes(Number(v)); // "" must never count as 0%

async function pool(list, size, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => {
        while (next < list.length) { const i = next++; await fn(list[i], i); }
    }));
}

// Reads every page of a query (PostgREST caps one response at ~1000 rows).
async function pageAll(build, max = Infinity) {
    const out = [];
    for (let from = 0; out.length < max; from += PAGE) {
        const { data, error } = await build().range(from, from + PAGE - 1);
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    return out;
}

function parseIds(raw, max) {
    const ids = [...new Set((Array.isArray(raw) ? raw : []).filter((x) => UUID_RE.test(String(x))))];
    if (!ids.length || ids.length > max) return { error: `Select between 1 and ${max} products at a time.` };
    return { ids };
}

/* ---------------------------------- image links ---------------------------------- */
function driveToDirectImageUrl(url) {
    const m = url.match(/drive\.google\.com\/file\/d\/([^/]+)/) || url.match(/[?&]id=([^&]+)/);
    return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000` : null;
}
async function resolveImgbbDirectUrl(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`imgbb page returned HTTP ${res.status}`);
    const html = await res.text();
    const m = html.match(/<meta property="og:image" content="([^"]+)"/);
    if (!m) throw new Error("couldn't find image on that imgbb page");
    return m[1];
}
async function toDirectImageUrl(raw) {
    const url = String(raw || "").trim();
    if (!url) return "";
    const drive = driveToDirectImageUrl(url);
    if (drive) return drive;
    if (/^https?:\/\/ibb\.co\//i.test(url)) { try { return await resolveImgbbDirectUrl(url); } catch { return url; } }
    return url;
}
function isDirectImageUrl(url) {
    const u = String(url || "").trim();
    if (!/^https?:\/\/\S+$/i.test(u)) return false;
    if (/^https?:\/\/ibb\.co\//i.test(u)) return false;
    if (/drive\.google\.com\/file\/d\//i.test(u) && !/\/thumbnail\?/i.test(u)) return false;
    if (/drive\.google\.com\/open\?/i.test(u)) return false;
    return true;
}

/* ---------------------------------- draft data ---------------------------------- */
// Old drafts that still carry category fields are cleaned here: those fields are simply dropped.
function cleanData(d) {
    const x = d && typeof d === "object" ? d : {};
    return {
        n: S(x.n), b: S(x.b), model: S(x.model), grade: S(x.grade),
        u: S(x.u, 40), ps: S(x.ps, 20), mps: S(x.mps, 20), gst: S(x.gst, 10).trim(),
        spec: (Array.isArray(x.spec) ? x.spec : []).slice(0, 40).map((s) => ({ key: S(s?.key, 100), value: S(s?.value, 300) })),
        im: (Array.isArray(x.im) ? x.im : []).filter((u) => typeof u === "string" && u.trim()).slice(0, 20).map((u) => u.trim().slice(0, 2000)),
    };
}

async function resolveDataImages(d) {
    const im = await Promise.all(d.im.map(toDirectImageUrl));
    return { ...d, im: [...new Set(im.filter(Boolean))].slice(0, MAX_PHOTOS) };
}

// Same rules as the review screen (utils/catalogBulkSchema.js).
function validateDraft(d) {
    const e = [];
    const len = (v) => String(v ?? "").trim().length;
    if (len(d.n) < 2) e.push("Enter the product name (at least 2 letters).");
    if (!len(d.b)) e.push("Enter the brand name.");
    if (!len(d.model)) e.push("Enter the model, part number or SKU.");
    if (!ALLOWED_UNITS.includes(d.u)) e.push("Pick a unit.");
    if (!(Number(d.ps) > 0)) e.push("Enter how many items are in 1 pack.");
    const mps = Number(d.mps);
    if (!(String(d.mps).trim() !== "" && Number.isInteger(mps) && mps >= 1)) e.push("Enter how many packs are in 1 outer box (1 if there is none).");
    if (!gstOk(d.gst)) e.push("Choose the GST % of this product.");
    if (!d.im.length) e.push("Add at least one product photo.");
    else if (d.im.some((u) => !isDirectImageUrl(u))) e.push("Some photo links can't be used. Remove them and upload the photo again.");
    return e;
}

/* ---------------------------------- catalog lookups ---------------------------------- */
// pairs: [{ n, b }] -> Set of indexes whose name + brand already exists (same rule as hs_gpb_identity_uq).
// Uses the SQL function catalog_existing_item_idx (one indexed query); falls back to one lookup per row if it is not installed.
async function existingIdx(pairs) {
    const out = new Set();
    const valid = pairs.map((p, i) => ({ i, n: S(p?.n).trim(), b: S(p?.b).trim() })).filter((p) => p.n && p.b);
    if (!valid.length) return out;

    const { data, error } = await supabase.rpc("catalog_existing_item_idx", { p_rows: valid });
    if (!error && Array.isArray(data)) { data.forEach((i) => out.add(Number(i))); return out; }

    await pool(valid, 8, async (p) => {
        const { data: d, error: e } = await supabase.from(ITEM_TABLE).select("id").is("deleted_at", null)
            .ilike("name", escLike(p.n)).ilike("brand_name", escLike(p.b)).limit(1);
        if (e) throw new Error(e.message);
        if (d?.length) out.add(p.i);
    });
    return out;
}

/* ---------------------------------- GET /meta ---------------------------------- */
export function getMeta(req, res) {
    res.json({ success: true, units: ALLOWED_UNITS, gstRates: GST_RATES, maxRows: MAX_ROWS, maxPhotos: MAX_PHOTOS });
}

/* ---------------------------------- POST /check ---------------------------------- */
// { rows: [{ n, b }] }  ->  items[i] = { dup }
export async function checkRows(req, res) {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || !rows.length || rows.length > MAX_CHECK) {
        return res.status(400).json({ success: false, message: `Send between 1 and ${MAX_CHECK} rows.` });
    }
    try {
        const found = await existingIdx(rows);
        res.json({ success: true, items: rows.map((_, i) => ({ dup: found.has(i) })) });
    } catch (e) { return fail(res, e, "check"); }
}

/* ---------------------------------- drafts CRUD ---------------------------------- */
const mapDraft = (r) => ({ ...r, status: "pending" });

// GET /drafts
export async function listDrafts(req, res) {
    try {
        const rows = await pageAll(() => supabase.from("admin_catalog_drafts").select(DRAFT_COLS)
            .eq("created_by", req.user.id)
            .order("created_at", { ascending: true }).order("row_no", { ascending: true }).order("id"), MAX_DRAFTS);
        // old drafts are normalised to the new shape so the review form never sees missing fields
        res.json({ success: true, items: rows.slice(0, MAX_DRAFTS).map((r) => mapDraft({ ...r, data: cleanData(r.data) })) });
    } catch (e) { return fail(res, e, "list drafts"); }
}

// POST /drafts { batchId, fileName, items: [{rowNo, data}] }
export async function createDrafts(req, res) {
    const { batchId, fileName, items } = req.body || {};
    if (!UUID_RE.test(String(batchId || ""))) return res.status(400).json({ success: false, message: "Invalid batch." });
    if (!Array.isArray(items) || !items.length || items.length > MAX_CHUNK) {
        return res.status(400).json({ success: false, message: `Send between 1 and ${MAX_CHUNK} products at a time.` });
    }
    for (const it of items) {
        if (!Number.isInteger(it?.rowNo) || it.rowNo < 1 || !validData(it.data, MAX_ITEM_CHARS)) {
            return res.status(400).json({ success: false, message: "One of the products is invalid or too large." });
        }
    }
    try {
        const { count, error: cErr } = await supabase.from("admin_catalog_drafts").select("id", { count: "exact", head: true }).eq("created_by", req.user.id);
        if (cErr) throw cErr;
        if ((count || 0) + items.length > MAX_DRAFTS) {
            return res.status(400).json({ success: false, message: `At most ${MAX_DRAFTS} unfinished products. Submit or discard some first.` });
        }

        const cleaned = items.map((it) => ({ rowNo: it.rowNo, data: cleanData(it.data) }));
        const resolved = new Array(cleaned.length);
        await pool(cleaned, 5, async (c, i) => { resolved[i] = await resolveDataImages(c.data); }); // Drive / imgbb links -> direct links

        const rows = cleaned.map((c, i) => ({
            created_by: req.user.id, batch_id: batchId, file_name: S(fileName, 200) || null, row_no: c.rowNo, data: resolved[i],
        }));
        const { error } = await supabase.from("admin_catalog_drafts").upsert(rows, { onConflict: "batch_id,row_no", ignoreDuplicates: true });
        if (error) throw error;

        const { data, error: sErr } = await supabase.from("admin_catalog_drafts").select(DRAFT_COLS)
            .eq("created_by", req.user.id).eq("batch_id", batchId).in("row_no", cleaned.map((c) => c.rowNo)).order("row_no", { ascending: true });
        if (sErr) throw sErr;
        res.json({ success: true, items: (data || []).map(mapDraft) });
    } catch (e) { return fail(res, e, "create drafts"); }
}

// PATCH /drafts/:id { data }
export async function updateDraft(req, res) {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ success: false, message: "Invalid item." });
    if (!validData(req.body?.data, MAX_ITEM_CHARS)) return res.status(400).json({ success: false, message: "Invalid or too large." });
    const { data, error } = await supabase.from("admin_catalog_drafts")
        .update({ data: cleanData(req.body.data), updated_at: new Date().toISOString() })
        .eq("id", req.params.id).eq("created_by", req.user.id).select("id").maybeSingle();
    if (error) return fail(res, error, "update draft");
    if (!data) return res.status(404).json({ success: false, message: "Item not found." });
    res.json({ success: true });
}

// DELETE /drafts/:id
export async function deleteDraft(req, res) {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ success: false, message: "Invalid item." });
    const { error } = await supabase.from("admin_catalog_drafts").delete().eq("id", req.params.id).eq("created_by", req.user.id);
    if (error) return fail(res, error, "delete draft");
    res.json({ success: true });
}

// DELETE /drafts   (discard everything this admin has saved)
export async function clearDrafts(req, res) {
    const { error } = await supabase.from("admin_catalog_drafts").delete().eq("created_by", req.user.id);
    if (error) return fail(res, error, "clear drafts");
    res.json({ success: true });
}

// POST /drafts/delete { ids }
export async function deleteDraftsBulk(req, res) {
    const p = parseIds(req.body?.ids, MAX_IDS);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    try {
        const gone = [];
        for (const c of chunks(p.ids, 100)) {
            const { data, error } = await supabase.from("admin_catalog_drafts").delete().eq("created_by", req.user.id).in("id", c).select("id");
            if (error) throw error;
            gone.push(...(data || []).map((r) => r.id));
        }
        res.json({ success: true, deleted: gone.length, ids: gone });
    } catch (e) { return fail(res, e, "delete drafts"); }
}

// POST /drafts/images { ids, images, mode }  -- same photos on many drafts
export async function setDraftImages(req, res) {
    const p = parseIds(req.body?.ids, MAX_IDS);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    const images = [...new Set((Array.isArray(req.body?.images) ? req.body.images : [])
        .map((u) => (typeof u === "string" ? u.trim() : "")).filter((u) => /^https?:\/\//i.test(u) && u.length <= 2000))];
    if (!images.length || images.length > MAX_PHOTOS) return res.status(400).json({ success: false, message: `Add between 1 and ${MAX_PHOTOS} photos.` });
    const mode = req.body?.mode === "replace" ? "replace" : "add";
    try {
        const rows = [];
        for (const c of chunks(p.ids, 50)) {
            const { data, error } = await supabase.from("admin_catalog_drafts").select("id, data").eq("created_by", req.user.id).in("id", c);
            if (error) throw error;
            rows.push(...(data || []));
        }
        const items = [];
        let failed = 0;
        await pool(rows, 10, async (row) => {
            const base = cleanData(row.data);
            const cur = mode === "replace" ? [] : base.im;
            const next = [...new Set([...cur, ...images])].slice(0, MAX_PHOTOS);
            const { error } = await supabase.from("admin_catalog_drafts").update({ data: { ...base, im: next }, updated_at: new Date().toISOString() }).eq("id", row.id);
            if (error) { failed += 1; console.error("[adminCatalogDrafts] draft images:", error.message); } else items.push({ id: row.id, im: next });
        });
        if (failed && !items.length) return res.status(500).json({ success: false, message: "Could not update the photos. Please try again." });
        res.json({ success: true, updated: items.length, skipped: p.ids.length - items.length, items });
    } catch (e) { return fail(res, e, "draft images"); }
}

/* ---------------------------------- POST /drafts/submit ---------------------------------- */
// { ids }  ->  results[]: { id, status: submitted | duplicate | invalid | failed | missing, message? }
// Submitted and duplicate drafts are removed. Everything else stays so nothing is lost.
export async function submitDrafts(req, res) {
    const p = parseIds(req.body?.ids, MAX_SUBMIT);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    try {
        const { data, error } = await supabase.from("admin_catalog_drafts").select(DRAFT_COLS).eq("created_by", req.user.id).in("id", p.ids);
        if (error) throw error;
        const byId = new Map((data || []).map((r) => [r.id, r]));

        const results = [];
        const todo = [];
        for (const id of p.ids) {
            const row = byId.get(id);
            if (!row) { results.push({ id, status: "missing", message: "This product was not found. It may already be submitted." }); continue; }
            const d = cleanData(row.data);
            const problems = validateDraft(d);
            if (problems.length) { results.push({ id, status: "invalid", message: problems[0] }); continue; }
            todo.push({ id, d });
        }

        // duplicates: already in the catalog (name + brand), or repeated inside this batch
        const found = await existingIdx(todo.map((t) => ({ n: t.d.n, b: t.d.b })));
        const seen = new Set();
        const toInsert = [];
        const now = new Date().toISOString();
        todo.forEach((t, i) => {
            const key = `${norm(t.d.n)}|${norm(t.d.b)}`;
            if (found.has(i) || seen.has(key)) { results.push({ id: t.id, status: "duplicate", message: "Already in the catalog, so it was skipped." }); return; }
            seen.add(key);
            toInsert.push({
                id: t.id,
                row: {
                    generic_product_id: null, // unmapped on purpose: it shows under "Needs mapping"
                    name: t.d.n.trim(),
                    brand_name: t.d.b.trim(),
                    brand_not_applicable: false,
                    model_no: t.d.model.trim(),
                    grade_variant: t.d.grade.trim() || null,
                    unit: t.d.u,
                    pack_size: Number(t.d.ps),
                    units_per_master_pack: Number(t.d.mps),
                    gst_percent: Number(t.d.gst),
                    specifications: t.d.spec.filter((s) => s.key.trim() && s.value.trim()).map((s) => ({ key: s.key.trim(), value: s.value.trim() })),
                    slug: slugify(`${t.d.n}-${t.d.b}`),
                    image: t.d.im[0],
                    images: t.d.im,
                    is_ai_generated: false,
                    review_status: "approved",
                    reviewed_at: now,
                    reviewed_by: req.user.id,
                },
            });
        });

        // insert in one query; if anything in it is rejected, fall back to one-by-one so only that row fails
        if (toInsert.length) {
            const bulk = await supabase.from(ITEM_TABLE).insert(toInsert.map((x) => x.row)).select("id");
            if (!bulk.error) toInsert.forEach((x) => results.push({ id: x.id, status: "submitted" }));
            else {
                for (const x of toInsert) {
                    const one = await supabase.from(ITEM_TABLE).insert(x.row).select("id").single();
                    if (!one.error) results.push({ id: x.id, status: "submitted" });
                    else if (one.error.code === "23505") results.push({ id: x.id, status: "duplicate", message: "Already in the catalog, so it was skipped." });
                    else results.push({ id: x.id, status: "failed", message: one.error.message || "Could not add this product." });
                }
            }
        }

        // drafts that are finished (added, or already there) are removed
        const done = results.filter((r) => r.status === "submitted" || r.status === "duplicate").map((r) => r.id);
        for (const c of chunks(done, 100)) {
            const { error: dErr } = await supabase.from("admin_catalog_drafts").delete().eq("created_by", req.user.id).in("id", c);
            if (dErr) console.error("[adminCatalogDrafts] cleanup:", dErr.message);
        }

        res.json({ success: true, results, warnings: [] });
    } catch (e) { return fail(res, e, "submit drafts"); }
}