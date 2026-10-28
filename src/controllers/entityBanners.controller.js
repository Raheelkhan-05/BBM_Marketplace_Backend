// controllers/entityBanners.controller.js — multi-shape banners for categories & subcategories (storage + API only)
import { supabaseAdmin } from "../config/supabase.js";
import {
    collectFiles, parseShapeList, isShape, validateAndUpload, removeObjects,
} from "../services/bannerImages.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = {
    category: { table: "hs_categories", cols: "id, name, slug" },
    subcategory: { table: "hs_subcategories", cols: "id, name, slug, category_id" },
};
const cleanAlt = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 140) || null;
const parseBool = (v, d) => (v === undefined ? d : v === true || v === "true" || v === "1");

function typeOf(req, res) {
    const t = TYPES[req.params.type];
    if (!t) { res.status(400).json({ success: false, message: "Type must be category or subcategory." }); return null; }
    return { key: req.params.type, ...t };
}
const toMap = (rows) => {
    const out = {};
    for (const r of rows || []) {
        (out[r.entity_id] ||= {})[r.shape] = { image_url: r.image_url, alt_text: r.alt_text || null, is_active: r.is_active };
    }
    return out;
};

// GET /api/catalog/entity-banners/:type?ids=a,b,c   (public; active banners only)
export async function getEntityBanners(req, res) {
    const t = typeOf(req, res); if (!t) return;
    const ids = String(req.query.ids || "").split(",").map((s) => s.trim()).filter((s) => UUID_RE.test(s)).slice(0, 200);
    let q = supabaseAdmin.from("catalog_entity_banners")
        .select("entity_id, shape, image_url, alt_text, is_active")
        .eq("entity_type", t.key).eq("is_active", true).range(0, 4999);
    if (ids.length) q = q.in("entity_id", ids);
    const { data, error } = await q;
    if (error) {
        console.error("[entity-banners] public list failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load banners." });
    }
    res.set("Cache-Control", "public, max-age=60");
    return res.json({ success: true, banners: toMap(data) });
}

// GET /api/admin/entity-banners/:type
export async function adminListEntityBanners(req, res) {
    const t = typeOf(req, res); if (!t) return;
    const [e, b] = await Promise.all([
        supabaseAdmin.from(t.table).select(t.cols).is("deleted_at", null).order("name").range(0, 4999),
        supabaseAdmin.from("catalog_entity_banners")
            .select("entity_id, shape, image_url, alt_text, is_active").eq("entity_type", t.key).range(0, 19999),
    ]);
    if (e.error || b.error) {
        console.error("[entity-banners] admin list failed:", (e.error || b.error).message);
        return res.status(500).json({ success: false, message: "Couldn't load banners." });
    }
    const map = toMap(b.data);
    return res.json({ success: true, items: (e.data || []).map((x) => ({ ...x, banners: map[x.id] || {} })) });
}

// PUT /api/admin/entity-banners/:type/:id
// multipart: wide? landscape? square? portrait?, removeShapes?, altText?, isActive?
export async function adminUpsertEntityBanner(req, res) {
    const t = typeOf(req, res); if (!t) return;
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: "Invalid id." });

    const files = collectFiles(req);
    const remove = parseShapeList(req.body.removeShapes).filter((s) => !files[s]);
    if (!Object.keys(files).length && !remove.length) {
        return res.status(400).json({ success: false, message: "Choose an image first." });
    }

    const { data: entity, error: entErr } = await supabaseAdmin.from(t.table).select("id").eq("id", id).is("deleted_at", null).maybeSingle();
    if (entErr) return res.status(500).json({ success: false, message: "Couldn't save the banner." });
    if (!entity) return res.status(404).json({ success: false, message: `That ${t.key} doesn't exist.` });

    const up = await validateAndUpload(files, `${t.key}/${id}`);
    if (!up.ok) return res.status(up.status).json({ success: false, message: up.message });

    const touched = [...up.uploaded.map((u) => u.shape), ...remove];
    const { data: old } = await supabaseAdmin.from("catalog_entity_banners")
        .select("shape, image_path").eq("entity_type", t.key).eq("entity_id", id).in("shape", touched);

    if (up.uploaded.length) {
        const nowIso = new Date().toISOString();
        const by = req.user?.id ? String(req.user.id) : null;
        const alt = req.body.altText !== undefined ? cleanAlt(req.body.altText) : null;
        const active = parseBool(req.body.isActive, true);
        const { error } = await supabaseAdmin.from("catalog_entity_banners").upsert(
            up.uploaded.map((u) => ({
                entity_type: t.key, entity_id: id, shape: u.shape, image_url: u.url, image_path: u.path,
                alt_text: alt, is_active: active, width: u.width, height: u.height, updated_at: nowIso, updated_by: by,
            })),
            { onConflict: "entity_type,entity_id,shape" }
        );
        if (error) {
            await removeObjects(up.uploaded.map((u) => u.path));
            console.error("[entity-banners] upsert failed:", error.message);
            return res.status(500).json({ success: false, message: "Couldn't save the banner." });
        }
    }
    if (remove.length) {
        const { error } = await supabaseAdmin.from("catalog_entity_banners")
            .delete().eq("entity_type", t.key).eq("entity_id", id).in("shape", remove);
        if (error) console.error("[entity-banners] remove failed:", error.message);
    }
    await removeObjects((old || []).map((o) => o.image_path));

    const { data: rows } = await supabaseAdmin.from("catalog_entity_banners")
        .select("entity_id, shape, image_url, alt_text, is_active").eq("entity_type", t.key).eq("entity_id", id);
    return res.json({ success: true, banners: toMap(rows)[id] || {} });
}

// PATCH /api/admin/entity-banners/:type/:id   (json: altText?, isActive?) — applies to every shape
export async function adminPatchEntityBanner(req, res) {
    const t = typeOf(req, res); if (!t) return;
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: "Invalid id." });
    const patch = { updated_at: new Date().toISOString(), updated_by: req.user?.id ? String(req.user.id) : null };
    if (req.body?.altText !== undefined) patch.alt_text = cleanAlt(req.body.altText);
    if (req.body?.isActive !== undefined) patch.is_active = !!req.body.isActive;
    const { data, error } = await supabaseAdmin.from("catalog_entity_banners")
        .update(patch).eq("entity_type", t.key).eq("entity_id", id).select("shape");
    if (error) return res.status(500).json({ success: false, message: "Couldn't update the banner." });
    if (!data?.length) return res.status(404).json({ success: false, message: "Banner not found." });
    return res.json({ success: true });
}

// DELETE /api/admin/entity-banners/:type/:id            (all shapes)
// DELETE /api/admin/entity-banners/:type/:id/:shape     (one shape)
export async function adminDeleteEntityBanner(req, res) {
    const t = typeOf(req, res); if (!t) return;
    const { id, shape } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: "Invalid id." });
    if (shape !== undefined && !isShape(shape)) return res.status(400).json({ success: false, message: "Invalid shape." });

    let q = supabaseAdmin.from("catalog_entity_banners").delete().eq("entity_type", t.key).eq("entity_id", id);
    if (shape) q = q.eq("shape", shape);
    const { data, error } = await q.select("image_path");
    if (error) return res.status(500).json({ success: false, message: "Couldn't delete the banner." });
    if (!data?.length) return res.status(404).json({ success: false, message: "Banner not found." });
    await removeObjects(data.map((d) => d.image_path));
    return res.json({ success: true });
}