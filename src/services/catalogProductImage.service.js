// services/catalogProductImage.service.js
// One product -> one clean 3:4 white-background PNG.
//   with a reference photo -> images.edit (keeps the real pack design)
//   without                -> images.generate (drawn from name / brand / details)
// The model returns 1024x1536 (2:3). It is placed on a pure white 1200x1600 (3:4) canvas, never stretched.
import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import { supabase } from "../config/supabase.js";

const MODEL = process.env.CATALOG_IMAGE_MODEL || "gpt-image-2";
const QUALITY = process.env.CATALOG_IMAGE_QUALITY || "medium"; // low | medium | high
const FIDELITY = process.env.CATALOG_IMAGE_INPUT_FIDELITY || "high";
const BUCKET = process.env.CATALOG_IMAGE_BUCKET || "catalog-images";
const GEN_SIZE = "1024x1536";
const MAX_REF_BYTES = 15 * 1024 * 1024;

export const OUT_W = 1200;
export const OUT_H = 1600; // 3:4
export const AI_FOLDER = "catalog-ai"; // the front end recognises AI images by this folder name

// retry = whether the queue should try again
export class JobError extends Error {
    constructor(message, retry = false) { super(message); this.retry = retry; }
}

let _client = null;
function client() {
    if (!process.env.OPENAI_API_KEY) throw new JobError("Image generation is not set up on the server.", false);
    // The queue does the retrying, so the SDK itself does not.
    return (_client ||= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 170_000, maxRetries: 0 }));
}

/* ---------------------------------- reference photo ---------------------------------- */
function safeRemote(raw) {
    let u;
    try { u = new URL(raw); } catch { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.startsWith("[")) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
    return true;
}

// Returns a PNG buffer, or null when the photo can't be used (the job then falls back to text-only).
async function loadReference(url) {
    if (!url || !safeRemote(url)) return null;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
        if (!res.ok) return null;
        if (Number(res.headers.get("content-length") || 0) > MAX_REF_BYTES) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_REF_BYTES) return null;
        return await sharp(buf).rotate().flatten({ background: "#ffffff" })
            .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    } catch { return null; }
}

/* ---------------------------------- prompt ---------------------------------- */
const T = (v, n = 200) => String(v ?? "").trim().slice(0, n);

export function buildPrompt(d, hasRef) {
    const brand = T(d.b), name = T(d.n);
    const title = brand && !name.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${name}` : name;
    const facts = [];
    if (T(d.grade)) facts.push(`variant / grade ${T(d.grade)}`);
    if (T(d.model)) facts.push(`model / part number ${T(d.model)}`);
    if (Number(d.ps) > 0 && T(d.u)) facts.push(`one retail pack contains ${T(d.ps, 20)} ${T(d.u, 40)}`);
    (Array.isArray(d.spec) ? d.spec : []).slice(0, 6).forEach((s) => { if (T(s?.key) && T(s?.value)) facts.push(`${T(s.key, 60)}: ${T(s.value, 80)}`); });

    return [
        `Create a professional e-commerce catalogue photograph of this exact retail product: "${title}".`,
        facts.length ? `Known details: ${facts.join("; ")}.` : "",
        hasRef
            ? "A reference photo of the real product is attached. Treat it as the ground truth: keep the product's exact shape, proportions, packaging design, colours, logo, label layout and every printed word and number identical. Only improve the presentation (clean white background, even studio lighting, sharper detail). Do not redesign, restyle or invent anything."
            : "Reproduce the real, current retail packaging of this product as faithfully as you can: the genuine shape, colour scheme, logo, typography and label layout of the brand. Do not invent a new design. If any text is uncertain, keep the label simple and clean rather than inventing wording.",
        "Composition: one single product only, shown straight on from the front, perfectly upright and centred, the whole product fully inside the frame with about 10% empty margin on every side, portrait orientation.",
        "Background: pure seamless white (#FFFFFF), no gradient, no floor line, no reflection. Only a very soft natural contact shadow directly under the product.",
        "Quality: sharp focus, crisp edges, accurate true-to-life colours, soft even studio lighting, realistic materials, high detail.",
        "Strictly avoid: extra objects, props, people, hands, additional products, watermarks, borders, captions, price tags, overlay text, distortion.",
    ].filter(Boolean).join("\n");
}

/* ---------------------------------- model call ---------------------------------- */
async function callModel(prompt, refPng) {
    const c = client();
    const base = { model: MODEL, prompt, size: GEN_SIZE, quality: QUALITY, n: 1 };
    let res;
    if (refPng) {
        const file = await toFile(refPng, "reference.png", { type: "image/png" });
        try {
            res = await c.images.edit({ ...base, image: file, input_fidelity: FIDELITY });
        } catch (e) {
            // some model versions don't take input_fidelity: retry without it
            if (e?.status === 400 && /input_fidelity/i.test(String(e?.message || ""))) res = await c.images.edit({ ...base, image: file });
            else throw e;
        }
    } else {
        res = await c.images.generate({ ...base, background: "opaque" });
    }
    const b64 = res?.data?.[0]?.b64_json;
    if (!b64) throw new JobError("The image service returned no image.", true);
    return Buffer.from(b64, "base64");
}

/* ---------------------------------- 2:3 -> 3:4 white canvas ---------------------------------- */
// The model's "white" is often 250-254. Lift it to true 255 so the padding is seamless and the background is pure white.
async function toCatalogPng(buf) {
    const meta = await sharp(buf).metadata();
    const w = meta.width || 1024, h = meta.height || 1536, S = 12;
    const spots = [[0, 0], [w - S, 0], [0, h - S], [w - S, h - S]];
    const means = await Promise.all(spots.map(async ([left, top]) => {
        const st = await sharp(buf).extract({ left, top, width: S, height: S }).stats();
        return st.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3;
    }));
    const avg = means.reduce((a, b) => a + b, 0) / means.length;
    let src = buf;
    if (Math.min(...means) >= 225 && avg < 254.5) {
        src = await sharp(buf).removeAlpha().linear(255 / avg, 0).toBuffer();
    }
    return sharp(src)
        .resize({ width: OUT_W, height: OUT_H, fit: "contain", background: "#ffffff", kernel: "lanczos3" })
        .flatten({ background: "#ffffff" })
        .png({ compressionLevel: 9 })
        .toBuffer();
}

// data = cleaned draft data. refUrl = photo to copy from (or null).
export async function generateProductImage({ data, refUrl }) {
    const ref = refUrl ? await loadReference(refUrl) : null;
    const raw = await callModel(buildPrompt(data, !!ref), ref);
    return toCatalogPng(raw);
}

/* ---------------------------------- storage ---------------------------------- */
// Swap this for your existing uploader if you prefer. It only has to return a public https URL
// that contains "/catalog-ai/" so the review screen can mark it with an "AI" badge.
export async function storeProductImage(png, draftId) {
    const path = `${AI_FOLDER}/${draftId}-${Date.now()}.png`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, png, { contentType: "image/png", cacheControl: "31536000", upsert: false });
    if (error) throw new JobError(`Could not save the image (${error.message}).`, true);
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl;
}