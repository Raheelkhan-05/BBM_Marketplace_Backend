// controllers/adminCatalogDrafts.controller.js
// Admin-only. Full-hierarchy catalog bulk upload with a review screen.
//   - drafts: unfinished products, saved per admin (admin_catalog_drafts)
//   - check:  read-only lookup of which category / subcategory / generic product / product already exist
//   - submit: resolves (or creates) Category > Subcategory > Generic Product by NAME, then inserts the brand items
import { supabase } from "../config/supabase.js";
import { slugify } from "../services/slugify.js";
import { ALLOWED_UNITS } from "./sellerCatalogListings.controller.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DRAFTS = 2000, MAX_CHUNK = 50, MAX_ITEM_CHARS = 30000, MAX_IDS = 300;
const MAX_SUBMIT = 50, MAX_CHECK = 200, MAX_ROWS = 1000, MAX_PHOTOS = 8;
const DRAFT_COLS = "id, batch_id, file_name, row_no, data, created_at";
const PAGE = 1000;

const T = {
    category: "hs_categories",
    subcategory: "hs_subcategories",
    generic_product: "hs_generic_products",
    item: "hs_generic_product_brands",
};

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
function cleanData(d) {
    const x = d && typeof d === "object" ? d : {};
    return {
        cat: S(x.cat), catImg: S(x.catImg, 2000),
        sub: S(x.sub), subImg: S(x.subImg, 2000),
        gp: S(x.gp), gpImg: S(x.gpImg, 2000),
        n: S(x.n), b: S(x.b), mf: S(x.mf), model: S(x.model), grade: S(x.grade),
        u: S(x.u, 40), ps: S(x.ps, 20), mps: S(x.mps, 20),
        spec: (Array.isArray(x.spec) ? x.spec : []).slice(0, 40).map((s) => ({ key: S(s?.key, 100), value: S(s?.value, 300) })),
        im: (Array.isArray(x.im) ? x.im : []).filter((u) => typeof u === "string" && u.trim()).slice(0, 20).map((u) => u.trim().slice(0, 2000)),
    };
}

async function resolveDataImages(d) {
    const [catImg, subImg, gpImg] = await Promise.all([d.catImg, d.subImg, d.gpImg].map((u) => (u ? toDirectImageUrl(u) : "")));
    const im = await Promise.all(d.im.map(toDirectImageUrl));
    return { ...d, catImg, subImg, gpImg, im: [...new Set(im.filter(Boolean))].slice(0, MAX_PHOTOS) };
}

// Same rules as the review screen (utils/catalogBulkSchema.js). Hierarchy images are never blocking:
// an unusable one is simply left off when a NEW node is created.
function validateDraft(d) {
    const e = [];
    const len = (v) => String(v ?? "").trim().length;
    if (len(d.cat) < 2) e.push("Enter the category name (at least 2 letters).");
    if (len(d.sub) < 2) e.push("Enter the subcategory name (at least 2 letters).");
    if (len(d.gp) < 2) e.push("Enter the generic product name (at least 2 letters).");
    if (len(d.n) < 2) e.push("Enter the product name (at least 2 letters).");
    if (!len(d.b)) e.push("Enter the brand name.");
    if (!len(d.mf)) e.push("Enter the manufacturer.");
    if (!len(d.model)) e.push("Enter the model, part number or SKU.");
    if (!ALLOWED_UNITS.includes(d.u)) e.push("Pick a unit.");
    if (!(Number(d.ps) > 0)) e.push("Enter how many items are in 1 pack.");
    const mps = Number(d.mps);
    if (!(Number.isInteger(mps) && mps >= 1)) e.push("Enter how many packs are in 1 outer box (1 if there is none).");
    if (!d.im.length) e.push("Add at least one product photo.");
    else if (d.im.some((u) => !isDirectImageUrl(u))) e.push("Some photo links can't be used. Remove them and upload the photo again.");
    return e;
}

/* ---------------------------------- catalog lookups ---------------------------------- */
async function findNode(table, name, parentCol, parentId) {
    let q = supabase.from(table).select("id").ilike("name", escLike(String(name).trim())).order("id").limit(1);
    if (parentCol) q = q.eq(parentCol, parentId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data?.[0]?.id || null;
}

async function similarNames(table, name, parentCol, parentId) {
    const prefix = norm(name).slice(0, 5);
    if (prefix.length < 2) return [];
    let q = supabase.from(table).select("name").ilike("name", `%${escLike(prefix)}%`).limit(6);
    if (parentCol) q = q.eq(parentCol, parentId);
    const { data } = await q;
    return [...new Set((data || []).map((x) => x.name))].filter((n) => norm(n) !== norm(name)).slice(0, 4);
}

// Set of "genericProductId|name|brand" (lowercase) for every product already under the given generic products.
async function existingBrandKeys(gpIds) {
    const set = new Set();
    for (const c of chunks(gpIds, 50)) {
        const rows = await pageAll(() => supabase.from(T.item).select("generic_product_id, name, brand_name").in("generic_product_id", c).order("id"));
        rows.forEach((r) => set.add(`${r.generic_product_id}|${norm(r.name)}|${norm(r.brand_name)}`));
    }
    return set;
}

async function createNode(ctx, kind, name, parentCol, parentId, image) {
    const clean = String(name).trim();
    let img = null;
    if (image) {
        if (isDirectImageUrl(image)) img = image;
        else ctx.warnings.add(`A ${kind.replace("_", " ")} image link could not be used, so "${clean}" was created without an image.`);
    }
    const row = {
        name: clean,
        slug: slugify(`${clean}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
        is_ai_generated: false,
        review_status: "approved",
    };
    if (parentCol) row[parentCol] = parentId;
    if (img) row.image = img;
    const { data, error } = await supabase.from(T[kind]).insert(row).select("id").single();
    if (error) {
        if (error.code === "23505") { // created a moment ago by someone else: reuse it
            const id = await findNode(T[kind], clean, parentCol, parentId);
            if (id) return { id, created: false };
        }
        throw new Error(error.message);
    }
    return { id: data.id, created: true };
}

// One node per (kind, parent, name) per request: looked up once, created at most once.
async function resolveNode(ctx, kind, name, parentCol, parentId, image) {
    const key = `${kind}|${parentId || "root"}|${norm(name)}`;
    if (ctx.cache.has(key)) return ctx.cache.get(key);
    let id = await findNode(T[kind], name, parentCol, parentId);
    if (id) ctx.stats[kind].reused += 1;
    else {
        const r = await createNode(ctx, kind, name, parentCol, parentId, image);
        id = r.id;
        ctx.stats[kind][r.created ? "created" : "reused"] += 1;
    }
    ctx.cache.set(key, id);
    return id;
}

/* ---------------------------------- GET /meta ---------------------------------- */
export function getMeta(req, res) {
    res.json({ success: true, units: ALLOWED_UNITS, maxRows: MAX_ROWS, maxPhotos: MAX_PHOTOS });
}

/* ---------------------------------- POST /check ---------------------------------- */
// { rows: [{cat, sub, gp, n, b}], similar?: boolean }  ->  items[i] = { cat, sub, gp: {exists, similar?}, dup }
export async function checkRows(req, res) {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || !rows.length || rows.length > MAX_CHECK) {
        return res.status(400).json({ success: false, message: `Send between 1 and ${MAX_CHECK} rows.` });
    }
    const withSimilar = req.body?.similar === true && rows.length === 1;
    try {
        const cache = new Map();
        const memo = (k, fn) => { if (!cache.has(k)) cache.set(k, fn()); return cache.get(k); };
        const out = new Array(rows.length);
        const gpOf = new Array(rows.length).fill(null);

        await pool(rows, 8, async (r, i) => {
            const cat = S(r?.cat).trim(), sub = S(r?.sub).trim(), gp = S(r?.gp).trim();
            const o = { cat: { exists: false }, sub: { exists: false }, gp: { exists: false }, dup: false };
            let catId = null, subId = null, gpId = null;
            if (cat.length >= 2) catId = await memo(`c|${norm(cat)}`, () => findNode(T.category, cat, null, null));
            o.cat.exists = !!catId;
            if (catId && sub.length >= 2) subId = await memo(`s|${catId}|${norm(sub)}`, () => findNode(T.subcategory, sub, "category_id", catId));
            o.sub.exists = !!subId;
            if (subId && gp.length >= 2) gpId = await memo(`g|${subId}|${norm(gp)}`, () => findNode(T.generic_product, gp, "subcategory_id", subId));
            o.gp.exists = !!gpId;
            if (withSimilar) {
                if (cat.length >= 2 && !catId) o.cat.similar = await similarNames(T.category, cat, null, null);
                if (catId && sub.length >= 2 && !subId) o.sub.similar = await similarNames(T.subcategory, sub, "category_id", catId);
                if (subId && gp.length >= 2 && !gpId) o.gp.similar = await similarNames(T.generic_product, gp, "subcategory_id", subId);
            }
            gpOf[i] = gpId;
            out[i] = o;
        });

        const gpIds = [...new Set(gpOf.filter(Boolean))];
        if (gpIds.length) {
            const keys = await existingBrandKeys(gpIds);
            rows.forEach((r, i) => {
                if (gpOf[i] && S(r?.n).trim() && S(r?.b).trim()) out[i].dup = keys.has(`${gpOf[i]}|${norm(r.n)}|${norm(r.b)}`);
            });
        }
        res.json({ success: true, items: out });
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
        res.json({ success: true, items: rows.slice(0, MAX_DRAFTS).map(mapDraft) });
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
            const base = row.data && typeof row.data === "object" ? row.data : {};
            const cur = mode === "replace" ? [] : (Array.isArray(base.im) ? base.im.filter((u) => typeof u === "string" && u) : []);
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

        const ctx = {
            cache: new Map(), warnings: new Set(),
            stats: { category: { created: 0, reused: 0 }, subcategory: { created: 0, reused: 0 }, generic_product: { created: 0, reused: 0 } },
        };

        // 1) hierarchy, one row at a time so a new category is created once and then reused
        const resolved = [];
        for (const t of todo) {
            try {
                const cat = await resolveNode(ctx, "category", t.d.cat, null, null, t.d.catImg);
                const sub = await resolveNode(ctx, "subcategory", t.d.sub, "category_id", cat, t.d.subImg);
                const gp = await resolveNode(ctx, "generic_product", t.d.gp, "subcategory_id", sub, t.d.gpImg);
                resolved.push({ ...t, gpId: gp });
            } catch (e) { results.push({ id: t.id, status: "failed", message: e.message || "Could not set up the category path." }); }
        }

        // 2) duplicates: already in the catalog, or repeated inside this batch
        const existing = await existingBrandKeys([...new Set(resolved.map((r) => r.gpId))]);
        const seen = new Set();
        const toInsert = [];
        for (const r of resolved) {
            const key = `${r.gpId}|${norm(r.d.n)}|${norm(r.d.b)}`;
            if (existing.has(key) || seen.has(key)) { results.push({ id: r.id, status: "duplicate", message: "Already in the catalog, so it was skipped." }); continue; }
            seen.add(key);
            toInsert.push({
                id: r.id,
                row: {
                    generic_product_id: r.gpId,
                    name: r.d.n.trim(),
                    brand_name: r.d.b.trim(),
                    manufacturer: r.d.mf.trim(),
                    model_no: r.d.model.trim(),
                    grade_variant: r.d.grade.trim() || null,
                    unit: r.d.u,
                    pack_size: Number(r.d.ps),
                    units_per_master_pack: Number(r.d.mps),
                    specifications: r.d.spec.filter((s) => s.key.trim() && s.value.trim()).map((s) => ({ key: s.key.trim(), value: s.value.trim() })),
                    slug: slugify(`${r.d.n}-${r.d.b}`),
                    image: r.d.im[0],
                    images: r.d.im,
                    is_ai_generated: false,
                    review_status: "approved",
                },
            });
        }

        // 3) insert in one query; if anything in it is rejected, fall back to one-by-one so only that row fails
        if (toInsert.length) {
            const bulk = await supabase.from(T.item).insert(toInsert.map((x) => x.row)).select("id");
            if (!bulk.error) toInsert.forEach((x) => results.push({ id: x.id, status: "submitted" }));
            else {
                for (const x of toInsert) {
                    const one = await supabase.from(T.item).insert(x.row).select("id").single();
                    if (!one.error) results.push({ id: x.id, status: "submitted" });
                    else if (one.error.code === "23505") results.push({ id: x.id, status: "duplicate", message: "Already in the catalog, so it was skipped." });
                    else results.push({ id: x.id, status: "failed", message: one.error.message || "Could not add this product." });
                }
            }
        }

        // 4) drafts that are finished (added, or already there) are removed
        const done = results.filter((r) => r.status === "submitted" || r.status === "duplicate").map((r) => r.id);
        for (const c of chunks(done, 100)) {
            const { error: dErr } = await supabase.from("admin_catalog_drafts").delete().eq("created_by", req.user.id).in("id", c);
            if (dErr) console.error("[adminCatalogDrafts] cleanup:", dErr.message);
        }

        res.json({ success: true, results, hierarchyStats: ctx.stats, warnings: [...ctx.warnings] });
    } catch (e) { return fail(res, e, "submit drafts"); }
}