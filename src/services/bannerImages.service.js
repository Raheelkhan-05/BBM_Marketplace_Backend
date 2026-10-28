// services/bannerImages.service.js — shared shape rules, validation and storage helpers
import multer from "multer";
import { supabaseAdmin } from "../config/supabase.js";

export const BANNER_BUCKET = "group-banners";
export const SHAPES = {
    wide: { ratio: 16 / 9, label: "16:9" },
    landscape: { ratio: 4 / 3, label: "4:3" },
    square: { ratio: 1, label: "1:1" },
    portrait: { ratio: 3 / 4, label: "3:4" },
};
export const SHAPE_KEYS = Object.keys(SHAPES);
export const isShape = (s) => Object.prototype.hasOwnProperty.call(SHAPES, s);

export const MAX_BYTES = 2 * 1024 * 1024;
const RATIO_TOLERANCE = 0.02;
const MIN_SHORT_SIDE = 480;

export function detectImage(buf) {
    if (!buf || buf.length < 32) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
    if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return { mime: "image/webp", ext: "webp" };
    return null;
}

// Reads pixel size straight from the file header (no image library needed).
export function readImageSize(buf, mime) {
    try {
        if (mime === "image/png") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        if (mime === "image/jpeg") {
            let i = 2;
            while (i + 9 < buf.length) {
                if (buf[i] !== 0xff) { i++; continue; }
                const m = buf[i + 1];
                if (m === 0xff) { i++; continue; }
                if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
                const len = buf.readUInt16BE(i + 2);
                if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
                    return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
                }
                i += 2 + len;
            }
            return null;
        }
        if (mime === "image/webp") {
            const kind = buf.toString("ascii", 12, 16);
            if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
            if (kind === "VP8L") { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 }; }
            if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        }
    } catch { /* fall through */ }
    return null;
}

export function validateBannerFile(file, shape) {
    const type = detectImage(file.buffer);
    if (!type) return { ok: false, message: "Only JPEG, PNG or WebP images are allowed." };
    const dim = readImageSize(file.buffer, type.mime);
    if (!dim?.width || !dim?.height) return { ok: false, message: "Couldn't read the image size." };
    const { ratio, label } = SHAPES[shape];
    if (Math.abs(dim.width / dim.height - ratio) / ratio > RATIO_TOLERANCE) {
        return { ok: false, message: `The ${label} image must be exactly ${label}.` };
    }
    if (Math.min(dim.width, dim.height) < MIN_SHORT_SIDE) {
        return { ok: false, message: `The ${label} image is too small. Use a larger image.` };
    }
    return { ok: true, type, width: dim.width, height: dim.height };
}

export const publicUrl = (path) => supabaseAdmin.storage.from(BANNER_BUCKET).getPublicUrl(path).data.publicUrl;

export async function removeObjects(paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    const { error } = await supabaseAdmin.storage.from(BANNER_BUCKET).remove(list);
    if (error) console.error("[banners] storage cleanup failed:", error.message);
}

// Validates every file, then uploads them. All-or-nothing: on failure, whatever was uploaded is removed.
export async function validateAndUpload(files, prefix) {
    const prepared = [];
    for (const [shape, file] of Object.entries(files)) {
        const v = validateBannerFile(file, shape);
        if (!v.ok) return { ok: false, status: 400, message: v.message };
        prepared.push({ shape, file, ...v });
    }
    const uploaded = [];
    for (const p of prepared) {
        const path = `${prefix}/${p.shape}-${Date.now()}.${p.type.ext}`;
        const { error } = await supabaseAdmin.storage.from(BANNER_BUCKET)
            .upload(path, p.file.buffer, { contentType: p.type.mime, cacheControl: "31536000", upsert: false });
        if (error) {
            console.error("[banners] upload failed:", error.message);
            await removeObjects(uploaded.map((u) => u.path));
            return { ok: false, status: 500, message: "Couldn't upload the image." };
        }
        uploaded.push({ shape: p.shape, path, url: publicUrl(path), width: p.width, height: p.height });
    }
    return { ok: true, uploaded };
}

// multipart fields: wide | landscape | square | portrait  (+ legacy "image" = wide)
export function shapeUploader() {
    const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: SHAPE_KEYS.length + 1 } })
        .fields([{ name: "image", maxCount: 1 }, ...SHAPE_KEYS.map((name) => ({ name, maxCount: 1 }))]);
    return (req, res, next) => up(req, res, (err) => {
        if (!err) return next();
        const msg = err.code === "LIMIT_FILE_SIZE" ? "Image is too large (max 2 MB each)." : "Couldn't read the upload.";
        return res.status(400).json({ success: false, message: msg });
    });
}

export function collectFiles(req) {
    const out = {};
    for (const k of SHAPE_KEYS) { const f = req.files?.[k]?.[0]; if (f) out[k] = f; }
    if (!out.wide && req.files?.image?.[0]) out.wide = req.files.image[0];
    return out;
}

export const parseShapeList = (v) =>
    String(v ?? "").split(",").map((s) => s.trim()).filter(isShape);