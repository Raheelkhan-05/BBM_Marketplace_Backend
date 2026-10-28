// controllers/groupBanners.controller.js
import { supabaseAdmin } from "../config/supabase.js";
import {
    broadcastBannersChanged, getHomeBanners, scanCatalogGroups, getLastScan, PRIORITY_COUNT,
} from "../services/groupBanners.service.js";
import {
    shapeUploader, collectFiles, parseShapeList, validateAndUpload, removeObjects,
} from "../services/bannerImages.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ALT = 140;

/* ───────────────────────── public ───────────────────────── */

// GET /api/catalog/group-banners  ->  { banners, plan }
export async function getGroupBanners(req, res) {
    try {
        const { banners, plan } = await getHomeBanners();
        // Always revalidate (ETag -> cheap 304) so admin changes show immediately.
        res.set("Cache-Control", "public, max-age=0, must-revalidate");
        return res.json({ success: true, banners, plan });
    } catch {
        return res.status(500).json({ success: false, message: "Couldn't load banners." });
    }
}

/* ───────────────────────── admin ───────────────────────── */

export const bannerImageUpload = shapeUploader();

const parseBool = (v, d) => (v === undefined ? d : v === true || v === "true" || v === "1");
const cleanAlt = (v) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_ALT);
    return s || null;
};

// GET /api/admin/group-banners
export async function adminListGroupBanners(req, res) {
    const [g, b, i] = await Promise.all([
        supabaseAdmin.from("catalog_group_registry")
            .select("group_id, name, category_name, variant_count, is_active, first_seen_at, last_seen_at")
            .order("name", { ascending: true }).range(0, 4999),
        supabaseAdmin.from("group_banners")
            .select("group_id, image_url, alt_text, is_active, sort_order, updated_at")
            .order("sort_order", { ascending: true }).order("created_at", { ascending: true }).range(0, 4999),
        supabaseAdmin.from("group_banner_images")
            .select("group_id, shape, image_url").range(0, 19999),
    ]);
    if (g.error || b.error || i.error) {
        console.error("[group-banners] adminList failed:", (g.error || b.error || i.error).message);
        return res.status(500).json({ success: false, message: "Couldn't load groups." });
    }

    const extras = new Map();
    for (const r of i.data || []) {
        if (!extras.has(r.group_id)) extras.set(r.group_id, {});
        extras.get(r.group_id)[r.shape] = r.image_url;
    }
    const byGroup = new Map((b.data || []).map((x) => [x.group_id, { ...x, images: { wide: x.image_url, ...(extras.get(x.group_id) || {}) } }]));
    const groups = (g.data || []).map((r) => ({ ...r, banner: byGroup.get(r.group_id) || null }));

    // Exactly what buyers get today (live banners + today's layout), for the admin preview.
    let home = null;
    try { home = { ...(await getHomeBanners()), priorityCount: PRIORITY_COUNT }; } catch { /* preview is optional */ }

    return res.json({
        success: true,
        groups,
        order: (b.data || []).map((x) => x.group_id),
        home,
        lastScan: getLastScan().summary,
        lastScanAt: getLastScan().at || null,
    });
}

// PUT /api/admin/group-banners/:groupId
// multipart: wide? landscape? square? portrait? (image files), removeShapes? ("square,portrait"), altText?, isActive?
// The 16:9 ("wide") image is required the first time; the other shapes are optional.
export async function adminUpsertGroupBanner(req, res) {
    const { groupId } = req.params;
    if (!UUID_RE.test(groupId)) return res.status(400).json({ success: false, message: "Invalid group." });

    const files = collectFiles(req);
    const remove = parseShapeList(req.body.removeShapes).filter((s) => s !== "wide" && !files[s]);

    const { data: existing, error: exErr } = await supabaseAdmin
        .from("group_banners").select("*").eq("group_id", groupId).maybeSingle();
    if (exErr) return res.status(500).json({ success: false, message: "Couldn't save the banner." });
    if (!existing && !files.wide) {
        return res.status(400).json({ success: false, message: "Add the 16:9 image first. It's the base image for this group." });
    }

    const up = await validateAndUpload(files, groupId);
    if (!up.ok) return res.status(up.status).json({ success: false, message: up.message });
    const uploaded = up.uploaded;
    const wideUp = uploaded.find((u) => u.shape === "wide");
    const others = uploaded.filter((u) => u.shape !== "wide");
    const rollback = () => removeObjects(uploaded.map((u) => u.path));

    let sortOrder = existing?.sort_order;
    if (sortOrder == null) {
        const { data: last } = await supabaseAdmin.from("group_banners")
            .select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
        sortOrder = (last?.sort_order ?? 0) + 1;
    }

    const row = {
        group_id: groupId,
        image_url: wideUp ? wideUp.url : existing.image_url,
        image_path: wideUp ? wideUp.path : existing.image_path,
        alt_text: req.body.altText !== undefined ? cleanAlt(req.body.altText) : (existing?.alt_text ?? null),
        is_active: parseBool(req.body.isActive, existing?.is_active ?? true),
        sort_order: sortOrder,
        updated_at: new Date().toISOString(),
        updated_by: req.user?.id ? String(req.user.id) : null,
    };

    const { data, error } = await supabaseAdmin.from("group_banners")
        .upsert(row, { onConflict: "group_id" }).select().single();
    if (error) {
        await rollback();
        if (error.code === "23503") {
            return res.status(404).json({ success: false, message: "That group isn't in the registry yet. Run “Scan for new groups” and try again." });
        }
        console.error("[group-banners] upsert failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't save the banner." });
    }

    // Optional shapes
    const touched = [...others.map((o) => o.shape), ...remove];
    let oldImgs = [];
    if (touched.length) {
        const { data: old } = await supabaseAdmin.from("group_banner_images")
            .select("shape, image_path").eq("group_id", groupId).in("shape", touched);
        oldImgs = old || [];
    }
    if (others.length) {
        const nowIso = new Date().toISOString();
        const { error: imgErr } = await supabaseAdmin.from("group_banner_images").upsert(
            others.map((o) => ({
                group_id: groupId, shape: o.shape, image_url: o.url, image_path: o.path,
                width: o.width, height: o.height, updated_at: nowIso, updated_by: row.updated_by,
            })),
            { onConflict: "group_id,shape" }
        );
        if (imgErr) {
            await removeObjects(others.map((o) => o.path));
            console.error("[group-banners] extra images failed:", imgErr.message);
            return res.status(500).json({ success: false, message: "Couldn't save the extra banner sizes." });
        }
    }
    if (remove.length) {
        const { error: delErr } = await supabaseAdmin.from("group_banner_images")
            .delete().eq("group_id", groupId).in("shape", remove);
        if (delErr) console.error("[group-banners] remove shapes failed:", delErr.message);
    }

    const stale = oldImgs.map((o) => o.image_path);
    if (wideUp && existing?.image_path && existing.image_path !== wideUp.path) stale.push(existing.image_path);
    await removeObjects(stale);

    broadcastBannersChanged(req);
    return res.json({ success: true, banner: data });
}

// PATCH /api/admin/group-banners/:groupId   (json: altText?, isActive?)
export async function adminPatchGroupBanner(req, res) {
    const { groupId } = req.params;
    if (!UUID_RE.test(groupId)) return res.status(400).json({ success: false, message: "Invalid group." });

    const patch = { updated_at: new Date().toISOString(), updated_by: req.user?.id ? String(req.user.id) : null };
    if (req.body?.altText !== undefined) patch.alt_text = cleanAlt(req.body.altText);
    if (req.body?.isActive !== undefined) patch.is_active = !!req.body.isActive;

    const { data, error } = await supabaseAdmin.from("group_banners")
        .update(patch).eq("group_id", groupId).select().maybeSingle();
    if (error) {
        console.error("[group-banners] patch failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't update the banner." });
    }
    if (!data) return res.status(404).json({ success: false, message: "Banner not found." });

    broadcastBannersChanged(req);
    return res.json({ success: true, banner: data });
}

// DELETE /api/admin/group-banners/:groupId  (also removes every extra shape)
export async function adminDeleteGroupBanner(req, res) {
    const { groupId } = req.params;
    if (!UUID_RE.test(groupId)) return res.status(400).json({ success: false, message: "Invalid group." });

    const { data: extras } = await supabaseAdmin.from("group_banner_images")
        .select("image_path").eq("group_id", groupId);

    const { data, error } = await supabaseAdmin.from("group_banners")
        .delete().eq("group_id", groupId).select("image_path").maybeSingle(); // child rows cascade
    if (error) {
        console.error("[group-banners] delete failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't delete the banner." });
    }
    if (!data) return res.status(404).json({ success: false, message: "Banner not found." });

    await removeObjects([data.image_path, ...(extras || []).map((x) => x.image_path)]);
    broadcastBannersChanged(req);
    return res.json({ success: true });
}

// PUT /api/admin/group-banners/order   body: { groupIds: [uuid, ...] }  (full order, first = highest priority)
export async function adminReorderGroupBanners(req, res) {
    const ids = Array.isArray(req.body?.groupIds) ? req.body.groupIds.map(String) : null;
    if (!ids || !ids.length || ids.length > 2000 || !ids.every((x) => UUID_RE.test(x)) || new Set(ids).size !== ids.length) {
        return res.status(400).json({ success: false, message: "Invalid order." });
    }
    const { error } = await supabaseAdmin.rpc("group_banners_reorder", { p_ids: ids });
    if (error) {
        console.error("[group-banners] reorder failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't save the new order." });
    }
    broadcastBannersChanged(req);
    return res.json({ success: true });
}

// POST /api/admin/group-banners/scan
export async function adminScanGroups(req, res) {
    try {
        const summary = await scanCatalogGroups({ force: false });
        return res.json({ success: true, summary });
    } catch {
        return res.status(500).json({ success: false, message: "The scan failed. Check the server logs." });
    }
}