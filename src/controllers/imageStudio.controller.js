// controllers/imageStudio.controller.js
import multer from "multer";
import { supabaseAdmin } from "../config/supabase.js";
import { publishListingChange } from "../services/listingRealtime.service.js";
import { processAndStore, removeStored, normalizeOptions, WHITEBG_MARKER } from "../services/imageStudio.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PRODUCTS_PER_BATCH = 100;
const PAGE = 1000;

export const cutoutUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } }).single("file");

const fail = (res, code, message) => res.status(code).json({ success: false, message });
const isWhite = (u) => typeof u === "string" && u.includes(WHITEBG_MARKER);
const likeEscape = (s) => s.replace(/[\\%_,()]/g, " ").trim();

async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await build().range(from, from + PAGE - 1);
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    return out;
}

/* ----------------------------------------------------------------------------------------
 * GET /api/admin/image-studio/products?q=&filter=all|todo|done&page=1&pageSize=24
 * ---------------------------------------------------------------------------------------- */
export async function listProducts(req, res) {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 24));
        const filter = ["all", "todo", "done"].includes(req.query.filter) ? req.query.filter : "todo";
        const q = likeEscape(String(req.query.q || ""));

        let query = supabaseAdmin.from("hs_generic_product_brands")
            .select("id, name, brand_name, image, images", { count: "exact" })
            .is("deleted_at", null)
            .not("image", "is", null);
        if (q) query = query.or(`name.ilike.%${q}%,brand_name.ilike.%${q}%`);
        if (filter === "todo") query = query.not("image", "ilike", `%${WHITEBG_MARKER}%`);
        if (filter === "done") query = query.ilike("image", `%${WHITEBG_MARKER}%`);

        const from = (page - 1) * pageSize;
        const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, from + pageSize - 1);
        if (error) throw error;

        const items = (data || []).map((p) => ({
            id: p.id, name: p.name, brand: p.brand_name, image: p.image,
            imageCount: Array.isArray(p.images) ? p.images.length : 0,
            done: isWhite(p.image),
        }));
        return res.json({ success: true, items, total: count ?? items.length, page, pageSize });
    } catch (err) {
        console.error("[image-studio] list failed:", err?.message);
        return fail(res, 500, "Couldn't load products.");
    }
}

/* ----------------------------------------------------------------------------------------
 * POST /api/admin/image-studio/plan   { brandItemIds: [...], options?: {padding,size,enhance} }
 * Collects every distinct image URL used by each product (brand hero + gallery + all seller
 * listings) and creates the batch. The browser then processes each asset.
 * ---------------------------------------------------------------------------------------- */
export async function planBatch(req, res) {
    try {
        const ids = [...new Set((Array.isArray(req.body?.brandItemIds) ? req.body.brandItemIds : []).filter((i) => UUID_RE.test(String(i))))];
        if (!ids.length) return fail(res, 400, "Select at least one product.");
        if (ids.length > MAX_PRODUCTS_PER_BATCH) return fail(res, 400, `Please select at most ${MAX_PRODUCTS_PER_BATCH} products at a time.`);
        const options = normalizeOptions(req.body?.options);

        const brands = [];
        const subs = [];
        for (let i = 0; i < ids.length; i += 25) {
            const chunk = ids.slice(i, i + 25);
            const { data, error } = await supabaseAdmin.from("hs_generic_product_brands")
                .select("id, name, brand_name, image, images").in("id", chunk).is("deleted_at", null);
            if (error) throw error;
            brands.push(...(data || []));
            subs.push(...await fetchAll(() => supabaseAdmin.from("seller_product_submissions")
                .select("id, generic_product_brand_id, image").in("generic_product_brand_id", chunk).order("id")));
        }
        if (!brands.length) return fail(res, 404, "Those products no longer exist.");

        const { data: batch, error: bErr } = await supabaseAdmin.from("image_studio_batches")
            .insert({ created_by: req.user?.id || null, options }).select("id").single();
        if (bErr) throw bErr;

        const subsByBrand = new Map();
        for (const s of subs) {
            if (!subsByBrand.has(s.generic_product_brand_id)) subsByBrand.set(s.generic_product_brand_id, []);
            subsByBrand.get(s.generic_product_brand_id).push(s);
        }

        const plan = brands.map((b) => {
            const urls = new Set();
            if (b.image) urls.add(b.image);
            for (const u of b.images || []) if (u) urls.add(u);
            for (const s of subsByBrand.get(b.id) || []) if (s.image) urls.add(s.image);
            return { brand: b, urls: [...urls] };
        });

        const itemRows = plan.map((p) => ({
            batch_id: batch.id, brand_item_id: p.brand.id,
            status: !p.urls.length ? "failed" : p.urls.every(isWhite) ? "ready" : "processing",
            error: !p.urls.length ? "This product has no images." : null,
        }));
        const { data: items, error: iErr } = await supabaseAdmin.from("image_studio_items").insert(itemRows).select("id, brand_item_id, status");
        if (iErr) throw iErr;
        const itemByBrand = new Map(items.map((i) => [i.brand_item_id, i]));

        const assetRows = [];
        for (const p of plan) {
            const item = itemByBrand.get(p.brand.id);
            for (const u of p.urls) {
                // images we generated earlier are kept as-is (identity mapping)
                assetRows.push(isWhite(u)
                    ? { item_id: item.id, source_url: u, new_url: u, status: "done" }
                    : { item_id: item.id, source_url: u, status: "pending" });
            }
        }
        let assets = [];
        for (let i = 0; i < assetRows.length; i += 500) {
            const { data, error } = await supabaseAdmin.from("image_studio_assets").insert(assetRows.slice(i, i + 500)).select("id, item_id, source_url, new_url, status");
            if (error) throw error;
            assets.push(...data);
        }
        const assetsByItem = new Map();
        for (const a of assets) {
            if (!assetsByItem.has(a.item_id)) assetsByItem.set(a.item_id, []);
            assetsByItem.get(a.item_id).push(a);
        }

        return res.json({
            success: true, batchId: batch.id, options,
            items: plan.map((p) => {
                const item = itemByBrand.get(p.brand.id);
                return {
                    itemId: item.id, brandItemId: p.brand.id, name: p.brand.name, brand: p.brand.brand_name,
                    status: item.status, error: item.status === "failed" ? "This product has no images." : null,
                    listings: (subsByBrand.get(p.brand.id) || []).length,
                    assets: (assetsByItem.get(item.id) || []).map((a) => ({ id: a.id, sourceUrl: a.source_url, newUrl: a.new_url, status: a.status })),
                };
            }),
        });
    } catch (err) {
        console.error("[image-studio] plan failed:", err?.message);
        return fail(res, 500, "Couldn't prepare the batch.");
    }
}

async function refreshItemStatus(itemId) {
    const { data } = await supabaseAdmin.from("image_studio_assets").select("status").eq("item_id", itemId);
    const st = (data || []).map((r) => r.status);
    const status = st.includes("failed") ? "failed" : st.length && st.every((s) => s === "done") ? "ready" : "processing";
    const patch = { status, error: status === "failed" ? "One or more images could not be processed." : null };
    // never touch items that are already applied / reverted
    await supabaseAdmin.from("image_studio_items").update(patch).eq("id", itemId).in("status", ["processing", "ready", "failed"]);
    return status;
}

async function loadAsset(assetId) {
    if (!UUID_RE.test(String(assetId))) return null;
    const { data } = await supabaseAdmin.from("image_studio_assets")
        .select("id, item_id, status, image_studio_items!inner(id, batch_id, status, image_studio_batches!inner(options))")
        .eq("id", assetId).maybeSingle();
    return data;
}

/* ----------------------------------------------------------------------------------------
 * POST /api/admin/image-studio/assets/:assetId/process     multipart: file (transparent PNG)
 * ---------------------------------------------------------------------------------------- */
export async function processAsset(req, res) {
    try {
        const asset = await loadAsset(req.params.assetId);
        if (!asset) return fail(res, 404, "Image not found.");
        const item = asset.image_studio_items;
        if (!["processing", "ready", "failed"].includes(item.status)) return fail(res, 409, "This product was already applied.");
        if (!req.file?.buffer?.length) return fail(res, 400, "No image received.");

        const { storagePath, publicUrl } = await processAndStore({
            cutoutPng: req.file.buffer, options: item.image_studio_batches.options,
            batchId: item.batch_id, assetId: asset.id,
        });
        await supabaseAdmin.from("image_studio_assets")
            .update({ status: "done", new_url: publicUrl, storage_path: storagePath, error: null }).eq("id", asset.id);
        const itemStatus = await refreshItemStatus(item.id);
        return res.json({ success: true, assetId: asset.id, newUrl: publicUrl, itemId: item.id, itemStatus });
    } catch (err) {
        console.error("[image-studio] process failed:", err?.message);
        const msg = /No product found/.test(err?.message || "") ? err.message : "Couldn't finish this image.";
        try {
            await supabaseAdmin.from("image_studio_assets").update({ status: "failed", error: msg }).eq("id", req.params.assetId);
            const a = await loadAsset(req.params.assetId);
            if (a) await refreshItemStatus(a.item_id);
        } catch { /* best effort */ }
        return fail(res, 422, msg);
    }
}

/* POST /api/admin/image-studio/assets/:assetId/fail   { error } — the browser could not cut this image out */
export async function failAsset(req, res) {
    const asset = await loadAsset(req.params.assetId);
    if (!asset) return fail(res, 404, "Image not found.");
    await supabaseAdmin.from("image_studio_assets")
        .update({ status: "failed", error: String(req.body?.error || "Background removal failed.").slice(0, 300) }).eq("id", asset.id);
    const itemStatus = await refreshItemStatus(asset.item_id);
    return res.json({ success: true, itemId: asset.item_id, itemStatus });
}

/* POST /api/admin/image-studio/items/:itemId/retry — resets failed images so the browser can redo them */
export async function retryItem(req, res) {
    const { itemId } = req.params;
    if (!UUID_RE.test(String(itemId))) return fail(res, 400, "Invalid product.");
    const { data: item } = await supabaseAdmin.from("image_studio_items").select("id, status").eq("id", itemId).maybeSingle();
    if (!item || !["failed", "processing", "ready"].includes(item.status)) return fail(res, 404, "Nothing to retry.");
    const { data: reset, error } = await supabaseAdmin.from("image_studio_assets")
        .update({ status: "pending", error: null }).eq("item_id", itemId).eq("status", "failed").select("id, source_url");
    if (error) return fail(res, 500, "Couldn't retry.");
    await supabaseAdmin.from("image_studio_items").update({ status: "processing", error: null }).eq("id", itemId);
    return res.json({ success: true, assets: (reset || []).map((a) => ({ id: a.id, sourceUrl: a.source_url })) });
}

/* ----------------------------------------------------------------------------------------
 * POST /api/admin/image-studio/apply   { itemIds: [...], allOrNothing?: boolean }
 * ---------------------------------------------------------------------------------------- */
export async function applyItems(req, res) {
    const itemIds = [...new Set((Array.isArray(req.body?.itemIds) ? req.body.itemIds : []).filter((i) => UUID_RE.test(String(i))))];
    if (!itemIds.length) return fail(res, 400, "Nothing selected to apply.");
    const allOrNothing = req.body?.allOrNothing === true;

    const { data, error } = await supabaseAdmin.rpc("image_studio_apply_items", { p_item_ids: itemIds, p_all_or_nothing: allOrNothing });
    if (error) {
        console.error("[image-studio] apply failed:", error.message);
        const msg = allOrNothing
            ? `Nothing was changed. ${cleanErr(error.message)}`
            : "Couldn't apply the changes. Nothing was changed.";
        return fail(res, 409, msg);
    }
    const results = (data || []).map((r) => (r.ok ? r : { ...r, error: cleanErr(r.error) }));
    for (const r of results) if (r.ok) for (const sid of r.submission_ids || []) void publishListingChange(sid);
    return res.json({ success: true, results, applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
}

/* POST /api/admin/image-studio/items/:itemId/revert */
export async function revertItem(req, res) {
    const { itemId } = req.params;
    if (!UUID_RE.test(String(itemId))) return fail(res, 400, "Invalid product.");
    const { data, error } = await supabaseAdmin.rpc("image_studio_revert_item", { p_item_id: itemId });
    if (error) return fail(res, 409, cleanErr(error.message));
    for (const sid of data?.submission_ids || []) void publishListingChange(sid);
    return res.json({ success: true });
}

/* DELETE /api/admin/image-studio/batches/:batchId — drops everything not yet applied */
export async function discardBatch(req, res) {
    const { batchId } = req.params;
    if (!UUID_RE.test(String(batchId))) return fail(res, 400, "Invalid batch.");
    const { data: items } = await supabaseAdmin.from("image_studio_items").select("id, status").eq("batch_id", batchId);
    const drop = (items || []).filter((i) => !["applied", "reverted"].includes(i.status)).map((i) => i.id);
    if (drop.length) {
        const { data: assets } = await supabaseAdmin.from("image_studio_assets").select("storage_path").in("item_id", drop);
        await removeStored((assets || []).map((a) => a.storage_path));
        await supabaseAdmin.from("image_studio_items").delete().in("id", drop);
    }
    return res.json({ success: true, discarded: drop.length });
}

function cleanErr(m = "") {
    if (/CONFLICT/.test(m)) return "Images changed after processing. Re-run this product.";
    if (/PRODUCT_REMOVED/.test(m)) return "This product was removed.";
    if (/ITEM_NOT_READY/.test(m)) return "Not all images are ready yet.";
    if (/NOT_APPLIED/.test(m)) return "This product isn't applied.";
    return "Couldn't apply this product.";
}

/* ----------------------------------------------------------------------------------------
 * GET /api/admin/image-studio/proxy?url=...   (fallback when the image host blocks CORS)
 * Only fetches from hosts we trust, so it can't be used to reach internal addresses.
 * ---------------------------------------------------------------------------------------- */
function allowedHosts() {
    const hosts = new Set((process.env.IMAGE_PROXY_ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
    try { hosts.add(new URL(process.env.SUPABASE_URL).hostname.toLowerCase()); } catch { /* ignore */ }
    return hosts;
}
export async function proxyImage(req, res) {
    try {
        const u = new URL(String(req.query.url || ""));
        if (u.protocol !== "https:" || !allowedHosts().has(u.hostname.toLowerCase())) return fail(res, 400, "That image host isn't allowed.");
        const r = await fetch(u, { redirect: "error" });
        if (!r.ok) return fail(res, 502, "Couldn't fetch the image.");
        const type = r.headers.get("content-type") || "";
        if (!type.startsWith("image/")) return fail(res, 415, "Not an image.");
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 20 * 1024 * 1024) return fail(res, 413, "Image too large.");
        res.setHeader("Content-Type", type);
        res.setHeader("Cache-Control", "private, max-age=600");
        return res.send(buf);
    } catch {
        return fail(res, 400, "Invalid image URL.");
    }
}