// controllers/groupBanners.controller.js
import multer from "multer";
import { supabaseAdmin } from "../config/supabase.js";
import {
    BANNER_BUCKET, getActiveBanners, broadcastBannersChanged,
    scanCatalogGroups, getLastScan,
} from "../services/groupBanners.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ALT = 140;
const MAX_BYTES = 2 * 1024 * 1024;

/* ───────────────────────── public ───────────────────────── */

// GET /api/catalog/group-banners
export async function getGroupBanners(req, res) {
    try {
        const banners = await getActiveBanners();
        // Always revalidate (ETag -> cheap 304) so admin changes show immediately.
        res.set("Cache-Control", "public, max-age=0, must-revalidate");
        return res.json({ success: true, banners });
    } catch {
        return res.status(500).json({ success: false, message: "Couldn't load banners." });
    }
}

/* ───────────────────────── admin ───────────────────────── */

const uploader = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
export function bannerImageUpload(req, res, next) {
    uploader.single("image")(req, res, (err) => {
        if (!err) return next();
        const msg = err.code === "LIMIT_FILE_SIZE" ? "Image is too large (max 2 MB)." : "Couldn't read the upload.";
        return res.status(400).json({ success: false, message: msg });
    });
}

function detectImage(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
    if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return { mime: "image/webp", ext: "webp" };
    return null;
}

const parseBool = (v, d) => (v === undefined ? d : v === true || v === "true" || v === "1");
const cleanAlt = (v) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_ALT);
    return s || null;
};
const removeObject = async (path) => {
    if (!path) return;
    const { error } = await supabaseAdmin.storage.from(BANNER_BUCKET).remove([path]);
    if (error) console.error("[group-banners] storage cleanup failed:", error.message);
};

// GET /api/admin/group-banners
export async function adminListGroupBanners(req, res) {
    const [g, b] = await Promise.all([
        supabaseAdmin.from("catalog_group_registry")
            .select("group_id, name, category_name, variant_count, is_active, first_seen_at, last_seen_at")
            .order("name", { ascending: true }).range(0, 4999),
        supabaseAdmin.from("group_banners")
            .select("group_id, image_url, alt_text, is_active, sort_order, updated_at")
            .order("sort_order", { ascending: true }).order("created_at", { ascending: true }).range(0, 4999),
    ]);
    if (g.error || b.error) {
        console.error("[group-banners] adminList failed:", (g.error || b.error).message);
        return res.status(500).json({ success: false, message: "Couldn't load groups." });
    }
    const byGroup = new Map((b.data || []).map((x) => [x.group_id, x]));
    const groups = (g.data || []).map((r) => ({ ...r, banner: byGroup.get(r.group_id) || null }));
    return res.json({
        success: true,
        groups,
        order: (b.data || []).map((x) => x.group_id),
        lastScan: getLastScan().summary,
        lastScanAt: getLastScan().at || null,
    });
}

// PUT /api/admin/group-banners/:groupId   (multipart: image?, altText?, isActive?)
export async function adminUpsertGroupBanner(req, res) {
    const { groupId } = req.params;
    if (!UUID_RE.test(groupId)) return res.status(400).json({ success: false, message: "Invalid group." });

    const file = req.file || null;
    const { data: existing, error: exErr } = await supabaseAdmin
        .from("group_banners").select("*").eq("group_id", groupId).maybeSingle();
    if (exErr) return res.status(500).json({ success: false, message: "Couldn't save the banner." });
    if (!file && !existing) return res.status(400).json({ success: false, message: "Choose an image first." });

    let imageUrl = existing?.image_url;
    let imagePath = existing?.image_path;
    let uploadedPath = null;

    if (file) {
        const type = detectImage(file.buffer);
        if (!type) return res.status(400).json({ success: false, message: "Only JPEG, PNG or WebP images are allowed." });

        uploadedPath = `${groupId}/${Date.now()}.${type.ext}`;
        const { error: upErr } = await supabaseAdmin.storage.from(BANNER_BUCKET)
            .upload(uploadedPath, file.buffer, { contentType: type.mime, cacheControl: "31536000", upsert: false });
        if (upErr) {
            console.error("[group-banners] upload failed:", upErr.message);
            return res.status(500).json({ success: false, message: "Couldn't upload the image." });
        }
        imageUrl = supabaseAdmin.storage.from(BANNER_BUCKET).getPublicUrl(uploadedPath).data.publicUrl;
        imagePath = uploadedPath;
    }

    let sortOrder = existing?.sort_order;
    if (sortOrder == null) {
        const { data: last } = await supabaseAdmin.from("group_banners")
            .select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
        sortOrder = (last?.sort_order ?? 0) + 1;
    }

    const row = {
        group_id: groupId,
        image_url: imageUrl,
        image_path: imagePath,
        alt_text: req.body.altText !== undefined ? cleanAlt(req.body.altText) : (existing?.alt_text ?? null),
        is_active: parseBool(req.body.isActive, existing?.is_active ?? true),
        sort_order: sortOrder,
        updated_at: new Date().toISOString(),
        updated_by: req.user?.id ? String(req.user.id) : null,
    };

    const { data, error } = await supabaseAdmin.from("group_banners")
        .upsert(row, { onConflict: "group_id" }).select().single();

    if (error) {
        if (uploadedPath) await removeObject(uploadedPath);
        if (error.code === "23503") {
            return res.status(404).json({ success: false, message: "That group isn't in the registry yet. Run “Scan for new groups” and try again." });
        }
        console.error("[group-banners] upsert failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't save the banner." });
    }

    if (uploadedPath && existing?.image_path && existing.image_path !== uploadedPath) await removeObject(existing.image_path);
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

// DELETE /api/admin/group-banners/:groupId
export async function adminDeleteGroupBanner(req, res) {
    const { groupId } = req.params;
    if (!UUID_RE.test(groupId)) return res.status(400).json({ success: false, message: "Invalid group." });

    const { data, error } = await supabaseAdmin.from("group_banners")
        .delete().eq("group_id", groupId).select("image_path").maybeSingle();
    if (error) {
        console.error("[group-banners] delete failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't delete the banner." });
    }
    if (!data) return res.status(404).json({ success: false, message: "Banner not found." });

    await removeObject(data.image_path);
    broadcastBannersChanged(req);
    return res.json({ success: true });
}

// PUT /api/admin/group-banners/order   body: { groupIds: [uuid, ...] }  (full order, first = leftmost)
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