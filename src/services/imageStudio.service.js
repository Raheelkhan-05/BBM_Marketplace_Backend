// services/imageStudio.service.js
// Finishing pipeline for product images.
//
// The browser (admin's machine) does the heavy AI step - cutting the product out of its
// background - and uploads a transparent PNG. This service then does the cheap, deterministic
// part with `sharp`: tidy the mask, auto-levels / gamma / saturation, resize, sharpen, place on
// a pure-white square with a white margin ("border"), save as PNG, upload to Supabase Storage.
// Nothing heavy runs on Render, so the free instance stays fast and never runs out of memory.
import sharp from "sharp";
import { supabaseAdmin } from "../config/supabase.js";

sharp.cache(false);
sharp.concurrency(1);

export const BUCKET = process.env.IMAGE_STUDIO_BUCKET || "catalog-whitebg";
export const WHITEBG_MARKER = "/whitebg/";          // appears in every URL we generate
export const DEFAULT_OPTIONS = { padding: 0.08, size: 1200, enhance: true };
const ALLOWED_SIZES = [800, 1000, 1200, 1600];
const MAX_UPSCALE = 2;                                // never blow a small cutout up more than 2x

export function normalizeOptions(o = {}) {
    const padding = Math.min(0.2, Math.max(0.03, Number(o.padding)));
    const size = Number(o.size);
    return {
        padding: Number.isFinite(padding) ? padding : DEFAULT_OPTIONS.padding,
        size: ALLOWED_SIZES.includes(size) ? size : DEFAULT_OPTIONS.size,
        enhance: o.enhance === false ? false : true,
    };
}

// Simple counting semaphore so a burst of uploads can't exhaust Render's RAM.
let active = 0;
const waiters = [];
async function withSlot(fn, limit = 2) {
    if (active >= limit) await new Promise((r) => waiters.push(r));
    active++;
    try { return await fn(); }
    finally { active--; waiters.shift()?.(); }
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Mask clean-up + bounding box + tonal statistics, in a single pass over the pixels.
function analyse(px, w, h) {
    let minX = w, minY = h, maxX = -1, maxY = -1;
    const hist = new Uint32Array(256);
    let opaque = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            let a = px[i + 3];
            if (a < 10) a = 0; else if (a > 245) a = 255;     // kill faint haze / solidify the body
            px[i + 3] = a;
            if (a > 0) {
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
            if (a > 200) {
                hist[Math.round(lum(px[i], px[i + 1], px[i + 2]))]++;
                opaque++;
            }
        }
    }
    return { minX, minY, maxX, maxY, hist, opaque };
}

// Gentle auto-levels + gamma computed ONLY from product pixels (transparent area ignored).
function buildLut(hist, opaque) {
    const pct = (p) => {
        const target = opaque * p; let acc = 0;
        for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
        return 255;
    };
    let lo = pct(0.01), hi = pct(0.995);
    // limit the stretch so we never over-cook an already good photo
    if (hi - lo < 160) { const mid = (hi + lo) / 2; lo = Math.max(0, mid - 80); hi = Math.min(255, mid + 80); }
    lo = Math.min(lo, 40); hi = Math.max(hi, 215);

    let sum = 0;
    for (let i = 0; i < 256; i++) sum += hist[i] * Math.min(1, Math.max(0, (i - lo) / (hi - lo)));
    const mean = Math.min(0.9, Math.max(0.1, sum / opaque));
    // bring the mean tone towards ~0.48 (bright, clean "studio" look) but never by much
    let gamma = Math.log(0.48) / Math.log(mean);
    gamma = Math.min(1.25, Math.max(0.8, gamma));

    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        const v = Math.min(1, Math.max(0, (i - lo) / (hi - lo)));
        lut[i] = Math.round(Math.pow(v, gamma) * 255);
    }
    return lut;
}

function applyLut(px, w, h, lut) {
    for (let i = 0; i < w * h * 4; i += 4) {
        if (px[i + 3] === 0) continue;
        px[i] = lut[px[i]]; px[i + 1] = lut[px[i + 1]]; px[i + 2] = lut[px[i + 2]];
    }
}

/** cutoutPng: Buffer of a transparent PNG -> Buffer of the finished white-background PNG */
export async function renderWhiteBackground(cutoutPng, rawOptions) {
    const opt = normalizeOptions(rawOptions);
    const { data, info } = await sharp(cutoutPng, { limitInputPixels: 40e6 })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    const px = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);

    const st = analyse(px, w, h);
    if (st.maxX < 0 || st.opaque < 400) throw new Error("No product found in the image.");
    if (opt.enhance) applyLut(px, w, h, buildLut(st.hist, st.opaque));

    const cw = st.maxX - st.minX + 1, ch = st.maxY - st.minY + 1;
    const inner = Math.round(opt.size * (1 - 2 * opt.padding));
    const scale = Math.min(inner / cw, inner / ch, MAX_UPSCALE);
    const tw = Math.max(1, Math.round(cw * scale)), th = Math.max(1, Math.round(ch * scale));

    let pipeline = sharp(Buffer.from(px.buffer, px.byteOffset, px.length), { raw: { width: w, height: h, channels: 4 } })
        .extract({ left: st.minX, top: st.minY, width: cw, height: ch })
        .resize(tw, th, { kernel: "lanczos3", fit: "fill" });
    if (opt.enhance) {
        pipeline = pipeline.modulate({ saturation: 1.06 }).sharpen({ sigma: 0.7, m1: 0.6, m2: 1.6 });
    }
    const product = await pipeline.png().toBuffer();

    return sharp({ create: { width: opt.size, height: opt.size, channels: 3, background: "#ffffff" } })
        .composite([{ input: product, left: Math.round((opt.size - tw) / 2), top: Math.round((opt.size - th) / 2) }])
        .png({ compressionLevel: 9 })
        .toBuffer();
}

/** Render + upload. Returns { storagePath, publicUrl }. */
export function processAndStore({ cutoutPng, options, batchId, assetId }) {
    return withSlot(async () => {
        const out = await renderWhiteBackground(cutoutPng, options);
        const storagePath = `whitebg/${batchId}/${assetId}.png`;
        const { error } = await supabaseAdmin.storage.from(BUCKET)
            .upload(storagePath, out, { contentType: "image/png", upsert: true, cacheControl: "31536000" });
        if (error) throw new Error(`Upload failed: ${error.message}`);
        const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(storagePath);
        return { storagePath, publicUrl: data.publicUrl };
    });
}

export async function removeStored(paths) {
    const list = paths.filter(Boolean);
    for (let i = 0; i < list.length; i += 100) {
        await supabaseAdmin.storage.from(BUCKET).remove(list.slice(i, i + 100)).catch(() => { });
    }
}