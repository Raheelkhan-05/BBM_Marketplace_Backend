// services/catalogProductImage.service.js
// One product -> one clean 3:4 white-background PNG made from the REAL product photo.
// Nothing is generated or redrawn by AI.
//
//   1. SEARCH   Google Images (Serper), in two rounds:
//                 round 1 = exact pack size (name + size, plus Amazon / Flipkart / IndiaMART targeted)
//                 round 2 = same product line, any size
//   2. FILTER   download candidates (best title/URL matches first), keep photos with a plain light background
//   3. VERIFY   a vision model only JUDGES: same product line + variant codes + viscosity, same pack size, clean photo.
//                 exact size match is preferred; otherwise the same product line in the same container class
//                 (small bottle / bottle / can / drum) is accepted and the file is tagged "-approx".
//   4. FINISH   turn the plain background into pure white (only pixels connected to the photo edge),
//                 trim, and centre the untouched product on a pure white 1200x1600 (3:4) canvas.
// If nothing reliable exists the job fails with a clear message instead of guessing.
import OpenAI from "openai";
import sharp from "sharp";
import { supabase } from "../config/supabase.js";

const BUCKET = process.env.CATALOG_IMAGE_BUCKET || "catalog-images";
const SERPER_KEY = process.env.SERPER_API_KEY || "";                      // https://serper.dev (Google Images API)
const SEARCH_COUNTRY = process.env.CATALOG_SEARCH_COUNTRY || "in";        // Google "gl" parameter
const VISION_MODEL = process.env.CATALOG_VISION_MODEL || "gpt-4.1-mini";  // any vision-capable chat model
const ALLOW_SIZE_FALLBACK = process.env.CATALOG_ALLOW_SIZE_FALLBACK !== "off"; // "off" = exact pack size only
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_DOWNLOAD = 20;    // candidates downloaded per round
const MAX_TO_VISION = 10;   // photos shown to the vision model per round
const MIN_SIDE = 450;       // ignore thumbnails smaller than this
const MAX_UPSCALE = 2.5;    // reject photos that would have to be enlarged more than this (they would look blurry)
const FILL = 0.9;           // the product fills at most 90% of the canvas
const BG_TOL = 30;          // how far a pixel may differ from the background colour to count as background
const WORK_MAX = 1800;      // working size of a downloaded photo (the output only needs 1440px)

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

/* ---------------------------------- product names / pack size ---------------------------------- */
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

// "5 L", "900 ml", "3.5 Litre" -> litres (or null)
function parseLitres(s) {
    const m = String(s || "").toLowerCase().replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(ml|ltrs?|litres?|liters?|l|kg)\b/);
    if (!m) return null;
    const n = Number(m[1]);
    return m[2] === "ml" ? n / 1000 : n;
}
// small = hand-size bottle, bottle = 2-6 L bottle / jerrycan, can = 7-25 L pail / can, drum = 50 L+ barrel
const classOf = (l) => (l == null ? null : l <= 1.5 ? "small" : l <= 6 ? "bottle" : l <= 25 ? "can" : "drum");

function nameParts(d) {
    const title = productTitle(d);
    const paren = title.match(/\(([^)]*\d[^)]*)\)\s*$/);
    let size = paren ? paren[1].trim() : "";
    if (!size && Number(d.ps) > 0 && T(d.u)) size = `${T(d.ps, 20)} ${T(d.u, 40)}`;
    const core = title.replace(/\s*\([^)]*\)\s*$/, "").trim();                       // without the "(1 L)" part
    const short = core.replace(/\s+for\s+.*$/i, "").replace(/\s+/g, " ").trim();      // without "for Petrol & Diesel Cars"
    const litres = parseLitres(size);
    const key = litres == null ? "" : (/ml/i.test(size) ? `${Math.round(litres * 1000)}ml` : `${litres}l`);
    return { title, brand: T(d.b), core, short, size, litres, cls: classOf(litres), key };
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

// Looks at a 3px band around the photo. Returns { mean:[r,g,b], plain } where plain = the band is one light colour.
function borderInfo(data, w, h) {
    const B = Math.min(3, Math.max(1, (Math.min(w, h) >> 3)));
    const px = [];
    const add = (x, y) => { const o = (y * w + x) * 3; px.push(data[o], data[o + 1], data[o + 2]); };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (x < B || y < B || x >= w - B || y >= h - B) add(x, y);
    }
    const n = px.length / 3;
    const mean = [0, 0, 0];
    for (let i = 0; i < px.length; i += 3) { mean[0] += px[i]; mean[1] += px[i + 1]; mean[2] += px[i + 2]; }
    mean[0] /= n; mean[1] /= n; mean[2] /= n;
    let near = 0;
    for (let i = 0; i < px.length; i += 3) {
        if (Math.abs(px[i] - mean[0]) <= BG_TOL && Math.abs(px[i + 1] - mean[1]) <= BG_TOL && Math.abs(px[i + 2] - mean[2]) <= BG_TOL) near++;
    }
    const luma = 0.299 * mean[0] + 0.587 * mean[1] + 0.114 * mean[2];
    return { mean, plain: near / n >= 0.9 && luma >= 190 };
}

// Download one image. Returns { png (max 1800px), jpg (768px for the vision model), w, h, plain } or null.
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
        const png = await base.clone().resize({ width: WORK_MAX, height: WORK_MAX, fit: "inside", withoutEnlargement: true }).png().toBuffer();
        const jpg = await base.clone().resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        const m2 = await sharp(png).metadata();
        const raw = await sharp(jpg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const b = borderInfo(raw.data, raw.info.width, raw.info.height);
        return { png, jpg, w: m2.width || 0, h: m2.height || 0, plain: b.plain };
    } catch { return null; }
}

/* ---------------------------------- 1. search ---------------------------------- */
// Photos from stock sites are watermarked, so they are never used.
const BAD_DOMAINS = /(alamy|shutterstock|gettyimages|dreamstime|istockphoto|123rf|depositphotos|adobestock|vecteezy|freepik|pngtree|pngwing|clipart|pinimg)/i;
// Shops and brand sites that usually have clean packshots of technical products.
const GOOD_DOMAINS = /(amazon|flipkart|indiamart|shell\.|jiomart|bigbasket|boodmo|tradeindia|moglix|industrybuying|zoro|grainger)/i;

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
        url: i.imageUrl, page: i.link, title: i.title || "", domain: i.domain || i.source || "",
        w: Number(i.imageWidth) || 0, h: Number(i.imageHeight) || 0,
    }));
}

const sizeQueries = (n) => {
    const s = n.size;
    return [
        `${n.short} ${s}`,
        `${n.core} ${s}`,
        `${n.short} ${s} site:amazon.in`,
        `${n.short} ${s} site:flipkart.com`,
        `${n.short} ${s} site:indiamart.com`,
    ];
};
const lineQueries = (n) => [
    n.short,
    `${n.short} pack`,
    `${n.short} site:amazon.in`,
    `${n.short} site:flipkart.com`,
    `${n.short} site:indiamart.com`,
    `${n.short} site:shell.in`,
];

// Score a search hit by how many product words (and the pack size) its title / URL contain.
function scoreHit(c, n, tokens) {
    const hay = `${c.title} ${c.page} ${c.url}`.toLowerCase();
    const hits = tokens.filter((t) => hay.includes(t)).length;
    let s = tokens.length ? hits / tokens.length : 0;
    if (n.key) {
        const flat = hay.replace(/\b(litres?|liters?|ltrs?)\b/g, "l").replace(/\s+/g, "");
        if (flat.includes(n.key)) s += 0.3;
    }
    if (GOOD_DOMAINS.test(c.domain) || GOOD_DOMAINS.test(c.url)) s += 0.15;
    return s;
}

// Run the queries, rank the hits, download the best, keep photos with a plain light background.
async function getCandidates(n, queries, seen) {
    const settled = await Promise.allSettled(queries.map(serperImages));
    if (settled.every((s) => s.status === "rejected")) throw new Error(settled[0].reason?.message || "image search failed");

    const tokens = [...new Set(n.short.toLowerCase().split(/[^a-z0-9-]+/).filter((t) => t.length >= 2))];
    const found = [];
    for (const s of settled) {
        if (s.status !== "fulfilled") continue;
        for (const c of s.value) {
            if (!c?.url || seen.has(c.url) || !safeRemote(c.url)) continue;
            if (BAD_DOMAINS.test(c.domain) || BAD_DOMAINS.test(c.url)) continue;
            if (c.w && c.h && Math.min(c.w, c.h) < MIN_SIDE) continue;
            seen.add(c.url);
            found.push({ ...c, score: scoreHit(c, n, tokens) });
        }
    }
    found.sort((a, b) => b.score - a.score);

    const downloaded = await Promise.all(found.slice(0, MAX_DOWNLOAD).map(async (c) => ({ ...c, img: await fetchImage(c.url, { minSide: MIN_SIDE, timeout: 8000 }) })));
    const usable = downloaded.filter((c) => c.img);
    const plain = usable.filter((c) => c.img.plain);
    return { cands: plain.slice(0, MAX_TO_VISION), stats: { found: found.length, usable: usable.length, plain: plain.length } };
}

/* ---------------------------------- 2. verify (judge only, never edits) ---------------------------------- */
const VISION_INSTRUCTIONS = `You are a product-identification expert for an industrial / automotive e-commerce catalogue (lubricants, coolants, fluids, parts).
You are given numbered photos found on the web for ONE target product, and sometimes an "owner photo" that is the ground truth.

For EVERY numbered photo decide:
- same_line: true only if the photo shows the SAME product line as the target: same brand, same product name, same series and EVERY code in the target name (for example HX5 vs HX7, AX5 vs AX7, AZ, AH, ECT, R2 vs R3, S2 G) and the same viscosity grade (for example 5W-30 vs 15W-40 vs 20W-50). Read the printed label. A different series, code or viscosity, or a competing brand, is NOT the same line. If you cannot read it clearly, false.
- same_size: true if the pack size on the photo equals the target pack size (1 L = 1000 ml; 900 ml is not 1 L; 3.5 L is not 4 L). If the target has no pack size, true. If the photo shows a size you cannot read, judge by the container and answer false when unsure.
- container_class: the kind of container in the photo: "small" (hand-size bottle up to about 1.5 L), "bottle" (2 to 6 L bottle or jerrycan with a handle), "can" (7 to 25 L pail or can), "drum" (large barrel of 50 L or more), "other".
- clean_view: true if the whole product is visible, the main label faces the camera (a slight angle is fine), and it is sharp.
- single_product: false for collages, multi-pack bundles, sets of different products, or lifestyle scenes.
- watermark: true if there is a visible watermark, shop logo stamp, price badge, sale sticker or any overlay text that is not part of the pack.
- quality: 1-10 for sharpness, resolution and how clean the photo is as a catalogue image.

Return ONLY JSON:
{"matches":[{"index":0,"same_line":true,"same_size":true,"container_class":"small","clean_view":true,"single_product":true,"watermark":false,"quality":8,"reason":"short"}]}`;

async function judgePhotos(d, n, owner, cands) {
    const content = [{
        type: "text",
        text: `TARGET PRODUCT: "${n.title}"\nTARGET PACK SIZE: ${n.size || "not given"}${n.cls ? ` (container class: ${n.cls})` : ""}` +
            (productFacts(d).length ? `\nKnown details: ${productFacts(d).join("; ")}` : ""),
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

// Returns { exact: [cand...], approx: [cand...] }, each best first.
async function rankCandidates(d, n, owner, cands) {
    const verdict = await judgePhotos(d, n, owner, cands);
    const ms = (verdict.matches || []).filter((m) => m && cands[Number(m.index)]);
    const base = (m) => m.same_line === true && m.clean_view === true && m.single_product !== false && m.watermark !== true;
    const px = (m) => cands[Number(m.index)].img.w * cands[Number(m.index)].img.h;
    const best = (a, b) => (Number(b.quality) - Number(a.quality)) || (px(b) - px(a));

    const exact = ms.filter((m) => base(m) && m.same_size === true && Number(m.quality) >= 5).sort(best);
    const approx = ALLOW_SIZE_FALLBACK && n.cls
        ? ms.filter((m) => base(m) && m.same_size !== true && m.container_class === n.cls && Number(m.quality) >= 6).sort(best)
        : [];
    return { exact: exact.map((m) => cands[Number(m.index)]), approx: approx.map((m) => cands[Number(m.index)]) };
}

/* ---------------------------------- 3. finish: real photo -> pure white 3:4 canvas ---------------------------------- */
// Turns the plain background into pure white. Only pixels connected to the photo edge and close to the
// background colour are changed, so the product itself is never touched. Returns a PNG buffer or null.
async function whitenBackground(pngBuf) {
    const { data, info } = await sharp(pngBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height, n = w * h;
    const b = borderInfo(data, w, h);
    if (!b.plain) return null;
    const m = b.mean;

    const dist = (i) => { const o = i * 3; return Math.max(Math.abs(data[o] - m[0]), Math.abs(data[o + 1] - m[1]), Math.abs(data[o + 2] - m[2])); };
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    let sp = 0;
    const push = (i) => { if (!seen[i] && dist(i) <= BG_TOL) { seen[i] = 1; stack[sp++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
        const i = stack[--sp], x = i % w, y = (i / w) | 0;
        if (x > 0) push(i - 1);
        if (x < w - 1) push(i + 1);
        if (y > 0) push(i - w);
        if (y < h - 1) push(i + w);
    }
    // one extra pixel around the background: removes the faint halo of anti-aliased edges
    const halo = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (seen[i] || dist(i) > BG_TOL * 1.8) continue;
        if ((x > 0 && seen[i - 1]) || (x < w - 1 && seen[i + 1]) || (y > 0 && seen[i - w]) || (y < h - 1 && seen[i + w])) halo.push(i);
    }
    halo.forEach((i) => { seen[i] = 1; });

    let painted = 0;
    for (let i = 0; i < n; i++) if (seen[i]) { const o = i * 3; data[o] = data[o + 1] = data[o + 2] = 255; painted++; }
    if (painted < n * 0.05) return null; // almost nothing was background: not a usable packshot

    return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// Returns the final PNG, or null when the photo is unusable (not plain, or it would be enlarged too much).
async function toCatalogPng(img) {
    const clean = await whitenBackground(img.png);
    if (!clean) return null;

    const { data: trimmed, info } = await sharp(clean).trim({ background: "#ffffff", threshold: 10 }).toBuffer({ resolveWithObject: true });
    if (info.width < 50 || info.height < 50) return null;

    const boxW = Math.round(OUT_W * FILL), boxH = Math.round(OUT_H * FILL);
    const scale = Math.min(boxW / info.width, boxH / info.height);
    if (scale > MAX_UPSCALE) return null;

    const inner = await sharp(trimmed).resize({ width: boxW, height: boxH, fit: "inside", kernel: "lanczos3" }).png().toBuffer();
    return sharp({ create: { width: OUT_W, height: OUT_H, channels: 3, background: "#ffffff" } })
        .composite([{ input: inner, gravity: "centre" }])
        .png({ compressionLevel: 9 })
        .toBuffer();
}

async function firstUsable(list) {
    for (const c of list) {
        const png = await toCatalogPng(c.img);
        if (png) return { png, cand: c };
    }
    return null;
}

// data = cleaned draft data. refUrl = the owner's own photo (or null); it is only used as ground truth
// to verify the web photos, and as a last resort if it is already clean.
export async function generateProductImage({ data, refUrl }) {
    if (!SERPER_KEY) throw new JobError("Product photo search is not set up on the server.", false);
    if (T(data.n).length < 2 || !T(data.b)) throw new JobError("Add the product name and brand first.", false);

    const n = nameParts(data);
    const owner = refUrl ? await fetchImage(refUrl) : null;
    const seen = new Set();
    const rounds = [];
    if (n.size) rounds.push({ name: "exact size", queries: sizeQueries(n) });
    rounds.push({ name: "product line", queries: lineQueries(n) });

    let approxPool = [];
    for (const [i, round] of rounds.entries()) {
        const { cands, stats } = await getCandidates(n, round.queries, seen);
        let exact = [], approx = [];
        if (cands.length) ({ exact, approx } = await rankCandidates(data, n, owner, cands));
        console.log(`[catalogProductImage] "${n.title}" round ${i + 1} (${round.name}): ${stats.found} found, ${stats.usable} downloaded, ${stats.plain} plain background, vision accepted ${exact.length} exact / ${approx.length} approx-size`);

        const hit = await firstUsable(exact);
        if (hit) {
            console.log(`[catalogProductImage] "${n.title}": original photo (exact size) from ${hit.cand.page || hit.cand.url}`);
            return hit.png;
        }
        approxPool = approxPool.concat(approx);
    }

    // same product line and same container class, but not the exact pack size
    const approxHit = await firstUsable(approxPool);
    if (approxHit) {
        console.log(`[catalogProductImage] "${n.title}": original photo of the same line, different ${n.cls} size, from ${approxHit.cand.page || approxHit.cand.url}`);
        approxHit.png.sizeApprox = true; // storeProductImage tags the file name with "-approx"
        return approxHit.png;
    }

    // last resort: the owner's own photo, if it already has a plain background
    if (owner?.plain) {
        const png = await toCatalogPng(owner);
        if (png) {
            console.log(`[catalogProductImage] "${n.title}": no web match, used the uploaded photo`);
            return png;
        }
    }

    console.log(`[catalogProductImage] "${n.title}": no usable photo found`);
    throw new JobError("Could not find a clean original photo of this exact product. Please upload one.", false);
}

/* ---------------------------------- storage ---------------------------------- */
// Swap this for your existing uploader if you prefer. It only has to return a public https URL
// that contains "/catalog-ai/" so the review screen can mark it.
// Photos of the same product line in a different pack size get "-approx" in the file name.
export async function storeProductImage(png, draftId) {
    const path = `${AI_FOLDER}/${draftId}-${Date.now()}${png.sizeApprox ? "-approx" : ""}.png`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, png, { contentType: "image/png", cacheControl: "31536000", upsert: false });
    if (error) throw new JobError(`Could not save the image (${error.message}).`, true);
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl;
}