// services/catalogProductImage.service.js
// One product -> one clean 3:4 white-background PNG made from the REAL product photo.
// Nothing is generated or redrawn by AI. The pipeline is:
//   1. SEARCH   Google Images (Serper) for the exact brand / name / variant / pack size.
//   2. FILTER   download candidates, keep only photos that already have a plain white background.
//   3. VERIFY   a vision model only JUDGES which photos are exactly the same product (it never edits anything).
//   4. FINISH   trim the white border and place the untouched photo on a pure white 1200x1600 (3:4) canvas.
// If no exact, clean photo exists the job fails with a clear message instead of guessing.
import OpenAI from "openai";
import sharp from "sharp";
import { supabase } from "../config/supabase.js";

const BUCKET = process.env.CATALOG_IMAGE_BUCKET || "catalog-images";
const SERPER_KEY = process.env.SERPER_API_KEY || "";                      // https://serper.dev (Google Images API)
const SEARCH_COUNTRY = process.env.CATALOG_SEARCH_COUNTRY || "in";        // Google "gl" parameter
const VISION_MODEL = process.env.CATALOG_VISION_MODEL || "gpt-4.1-mini";  // any vision-capable chat model
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_CANDIDATES = 8;   // photos shown to the vision model
const MIN_SIDE = 500;       // ignore thumbnails smaller than this
const MAX_UPSCALE = 2.5;    // reject photos that would have to be enlarged more than this (they would look blurry)
const FILL = 0.9;           // the product fills at most 90% of the canvas (about 5% margin per side)

export const OUT_W = 1200;
export const OUT_H = 1600; // 3:4
export const AI_FOLDER = "catalog-ai"; // the front end recognises these images by this folder name

// retry = whether the queue should try again
export class JobError extends Error {
    constructor(message, retry = false) { super(message); this.retry = retry; }
}

let _client = null;
function client() {
    if (!process.env.OPENAI_API_KEY) throw new JobError("Image checking is not set up on the server.", false);
    // The queue does the retrying, so the SDK itself does not.
    return (_client ||= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000, maxRetries: 0 }));
}

const T = (v, n = 200) => String(v ?? "").trim().slice(0, n);

function productTitle(d) {
    const brand = T(d.b), name = T(d.n);
    return brand && !name.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${name}` : name;
}

function productFacts(d) {
    const facts = [];
    if (T(d.grade)) facts.push(`variant / grade ${T(d.grade)}`);
    if (T(d.model)) facts.push(`model / part number ${T(d.model)}`);
    if (Number(d.ps) > 0 && T(d.u)) facts.push(`one retail pack contains ${T(d.ps, 20)} ${T(d.u, 40)}`);
    (Array.isArray(d.spec) ? d.spec : []).slice(0, 6).forEach((s) => { if (T(s?.key) && T(s?.value)) facts.push(`${T(s.key, 60)}: ${T(s.value, 80)}`); });
    return facts;
}

/* ---------------------------------- image download helpers ---------------------------------- */
function safeRemote(raw) {
    let u;
    try { u = new URL(raw); } catch { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.startsWith("[")) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
    return true;
}

// Mean brightness (0-255) of the four corners: tells us if the photo already has a plain white background.
async function cornerStats(buf) {
    const meta = await sharp(buf).metadata();
    const w = meta.width || 1, h = meta.height || 1, S = Math.max(2, Math.min(8, w >> 3, h >> 3));
    const spots = [[0, 0], [w - S, 0], [0, h - S], [w - S, h - S]];
    const means = await Promise.all(spots.map(async ([left, top]) => {
        const st = await sharp(buf).extract({ left, top, width: S, height: S }).stats();
        return st.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3;
    }));
    return { min: Math.min(...means), avg: means.reduce((a, b) => a + b, 0) / means.length };
}

// Download one image. Returns { png (full size, max 3000px), jpg (768px for the vision model), w, h, white } or null.
async function fetchImage(url, { minSide = 0, timeout = 15000 } = {}) {
    if (!url || !safeRemote(url)) return null;
    try {
        const res = await fetch(url, {
            signal: AbortSignal.timeout(timeout),
            redirect: "follow",
            headers: { "User-Agent": "Mozilla/5.0 (compatible; BBMCatalogBot/1.0)", Accept: "image/*" },
        });
        if (!res.ok) return null;
        const type = res.headers.get("content-type") || "";
        if (type && !type.startsWith("image/")) return null;
        if (Number(res.headers.get("content-length") || 0) > MAX_BYTES) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BYTES) return null;

        const meta = await sharp(buf).metadata();
        if (minSide && Math.min(meta.width || 0, meta.height || 0) < minSide) return null;

        const base = sharp(buf).rotate().flatten({ background: "#ffffff" });
        const png = await base.clone().resize({ width: 3000, height: 3000, fit: "inside", withoutEnlargement: true }).png().toBuffer();
        const jpg = await base.clone().resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        const m2 = await sharp(png).metadata();
        const c = await cornerStats(jpg);
        return { png, jpg, w: m2.width || 0, h: m2.height || 0, white: c.min >= 235 };
    } catch { return null; }
}

/* ---------------------------------- 1. search ---------------------------------- */
// Photos from stock sites are watermarked, so they are never used.
const BAD_DOMAINS = /(alamy|shutterstock|gettyimages|dreamstime|istockphoto|123rf|depositphotos|adobestock|vecteezy|freepik|pngtree|pngwing|clipart|pinimg)/i;

async function serperImages(q) {
    const res = await fetch("https://google.serper.dev/images", {
        method: "POST",
        headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ q, num: 10, gl: SEARCH_COUNTRY }),
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`image search HTTP ${res.status}`);
    const j = await res.json();
    return (j.images || []).map((i) => ({
        url: i.imageUrl, page: i.link, title: i.title, domain: i.domain || i.source || "",
        w: Number(i.imageWidth) || 0, h: Number(i.imageHeight) || 0,
    }));
}

async function findCandidates(d) {
    const title = productTitle(d);
    const extra = [T(d.grade, 60), T(d.model, 60), Number(d.ps) > 0 && T(d.u) ? `${T(d.ps, 20)} ${T(d.u, 40)}` : ""].filter(Boolean).join(" ");
    const base = `${title} ${extra}`.trim();
    const queries = [base, `${base} front view`, `${base} white background`];

    const settled = await Promise.allSettled(queries.map(serperImages));
    if (settled.every((s) => s.status === "rejected")) throw new Error(settled[0].reason?.message || "image search failed");

    // interleave the result lists so every query contributes
    const lists = settled.map((s) => (s.status === "fulfilled" ? s.value : []));
    const seen = new Set(), found = [];
    for (let i = 0; i < 10; i++) {
        for (const list of lists) {
            const c = list[i];
            if (!c?.url || seen.has(c.url) || !safeRemote(c.url)) continue;
            if (BAD_DOMAINS.test(c.domain) || BAD_DOMAINS.test(c.url)) continue;
            if (c.w && c.h && Math.min(c.w, c.h) < MIN_SIDE) continue;
            seen.add(c.url);
            found.push(c);
        }
    }

    // keep only big enough photos that already have a plain white background
    const downloaded = await Promise.all(found.slice(0, 16).map(async (c) => ({ ...c, img: await fetchImage(c.url, { minSide: MIN_SIDE, timeout: 8000 }) })));
    return downloaded.filter((c) => c.img && c.img.white).slice(0, MAX_CANDIDATES);
}

/* ---------------------------------- 2. verify (judge only, never edits) ---------------------------------- */
const VISION_INSTRUCTIONS = `You are a product-identification expert for an e-commerce catalogue.
You are given numbered photos found on the web for ONE target product, and sometimes an "owner photo" that is the ground truth.

For EVERY numbered photo decide:
- same_product: true only if it shows EXACTLY the target product: same brand, same product name AND the same variant / flavour / size / pack type / generation where those are known. Compare the printed text on the pack. A different flavour, size, model or a competing brand is NOT the same product. If unsure, false.
- clean_front_view: true only if the whole product is visible, front facing, sharp.
- single_product: false if the photo is a collage, a multi-pack bundle, a set of different products, or a lifestyle scene.
- watermark: true if there is a visible watermark, logo stamp from a shop, price badge, "sale" sticker or any overlay text that is not part of the pack.
- quality: 1-10 for sharpness, resolution and how clean the photo is as a catalogue image.

Return ONLY JSON:
{"matches":[{"index":0,"same_product":true,"clean_front_view":true,"single_product":true,"watermark":false,"quality":8,"reason":"short"}]}`;

async function judgePhotos(d, owner, cands) {
    const content = [{
        type: "text",
        text: `TARGET PRODUCT: "${productTitle(d)}"${productFacts(d).length ? `\nKnown details: ${productFacts(d).join("; ")}` : ""}`,
    }];
    if (owner) {
        content.push({ type: "text", text: "OWNER PHOTO (ground truth, not numbered):" });
        content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${owner.jpg.toString("base64")}`, detail: "high" } });
    }
    cands.forEach((c, i) => {
        content.push({ type: "text", text: `Photo ${i} (from ${c.domain || "web"}):` });
        content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${c.img.jpg.toString("base64")}`, detail: "high" } });
    });

    const res = await client().chat.completions.create({
        model: VISION_MODEL,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: VISION_INSTRUCTIONS }, { role: "user", content }],
    });
    const raw = res?.choices?.[0]?.message?.content || "{}";
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// Returns the acceptable candidates, best first.
async function rankCandidates(d, owner, cands) {
    const verdict = await judgePhotos(d, owner, cands);
    return (verdict.matches || [])
        .filter((m) => m && cands[Number(m.index)]
            && m.same_product === true && m.clean_front_view === true
            && m.single_product !== false && m.watermark !== true && Number(m.quality) >= 6)
        .sort((a, b) => (Number(b.quality) - Number(a.quality)) || (cands[Number(b.index)].img.w * cands[Number(b.index)].img.h - cands[Number(a.index)].img.w * cands[Number(a.index)].img.h))
        .map((m) => cands[Number(m.index)]);
}

/* ---------------------------------- 3. finish: real photo -> pure white 3:4 canvas ---------------------------------- */
// The product pixels are only trimmed and resized, never redrawn.
// Returns the PNG, or null when the photo would have to be enlarged too much (it would look blurry).
async function toCatalogPng(img) {
    const { min, avg } = await cornerStats(img.png);
    let src = sharp(img.png).removeAlpha();
    // The "white" of a JPEG is often 250-254. Lift it to true 255 so the background is pure white.
    if (min >= 225 && avg < 254.5) src = src.linear(255 / avg, 0);
    const lifted = await src.png().toBuffer();

    const { data: trimmed, info } = await sharp(lifted)
        .trim({ background: "#ffffff", threshold: 14 })
        .toBuffer({ resolveWithObject: true });
    if (info.width < 50 || info.height < 50) return null;

    const boxW = Math.round(OUT_W * FILL), boxH = Math.round(OUT_H * FILL);
    const scale = Math.min(boxW / info.width, boxH / info.height);
    if (scale > MAX_UPSCALE) return null;

    const inner = await sharp(trimmed)
        .resize({ width: boxW, height: boxH, fit: "inside", kernel: "lanczos3" })
        .png().toBuffer();

    return sharp({ create: { width: OUT_W, height: OUT_H, channels: 3, background: "#ffffff" } })
        .composite([{ input: inner, gravity: "centre" }])
        .png({ compressionLevel: 9 })
        .toBuffer();
}

// data = cleaned draft data. refUrl = the owner's own photo (or null); it is only used as ground truth
// to verify the web photos, and as a last resort if it is already clean.
export async function generateProductImage({ data, refUrl }) {
    if (!SERPER_KEY) throw new JobError("Product photo search is not set up on the server.", false);
    if (T(data.n).length < 2 || !T(data.b)) throw new JobError("Add the product name and brand first.", false);

    const owner = refUrl ? await fetchImage(refUrl) : null;
    const cands = await findCandidates(data);
    const ranked = cands.length ? await rankCandidates(data, owner, cands) : [];

    for (const c of ranked) {
        const png = await toCatalogPng(c.img);
        if (png) {
            console.log(`[catalogProductImage] "${productTitle(data)}": original photo from ${c.page || c.url}`);
            return png;
        }
    }

    // last resort: the owner's own photo, if it already has a clean white background
    if (owner?.white) {
        const png = await toCatalogPng(owner);
        if (png) {
            console.log(`[catalogProductImage] "${productTitle(data)}": no web match, used the uploaded photo`);
            return png;
        }
    }

    console.log(`[catalogProductImage] "${productTitle(data)}": no exact clean photo found (${cands.length} candidates checked)`);
    throw new JobError("Could not find a clean original photo of this exact product. Please upload one.", false);
}

/* ---------------------------------- storage ---------------------------------- */
// Swap this for your existing uploader if you prefer. It only has to return a public https URL
// that contains "/catalog-ai/" so the review screen can mark it.
export async function storeProductImage(png, draftId) {
    const path = `${AI_FOLDER}/${draftId}-${Date.now()}.png`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, png, { contentType: "image/png", cacheControl: "31536000", upsert: false });
    if (error) throw new JobError(`Could not save the image (${error.message}).`, true);
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl;
}