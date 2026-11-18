// services/catalogProductImage.service.js
// One product -> one clean 3:4 white-background PNG made from the REAL product photo.
// Nothing is generated or redrawn by AI.
//
//   1. SEARCH   Two sources, in two rounds (round 1 = exact pack size, round 2 = same product line):
//                 - Google Images (Serper)
//                 - shop / brand product pages found by Google (Flipkart, IndiaMART, Amazon ...): their main product photo
//   2. FILTER   download the best title/URL matches, keep photos with a plain light background
//   3. VERIFY   a vision model only JUDGES (never edits). Identity can be proven by the printed label OR by the
//                 listing title, as long as the photo does not visibly contradict it.
//                 Exact pack size is preferred; otherwise the same product line in the same container class
//                 (small bottle / bottle / can / drum) is accepted and the file is tagged "-approx".
//   4. FINISH   plain background -> pure white (only pixels connected to the photo edge), trim, and centre the
//                 untouched product on a pure white 1200x1600 (3:4) canvas.
// If nothing reliable exists the job fails with a message that says where the photos were lost.
import OpenAI from "openai";
import sharp from "sharp";
import { supabase } from "../config/supabase.js";

const BUCKET = process.env.CATALOG_IMAGE_BUCKET || "catalog-images";
const SERPER_KEY = process.env.SERPER_API_KEY || "";                      // https://serper.dev
const SEARCH_COUNTRY = process.env.CATALOG_SEARCH_COUNTRY || "in";        // Google "gl" parameter
const VISION_MODEL = process.env.CATALOG_VISION_MODEL || "gpt-4.1-mini";  // any vision-capable chat model
// pack-size fallback: "class" (default) = same product line + same container class, "any" = same line, any size, "off" = exact size only
const FALLBACK = (process.env.CATALOG_ALLOW_SIZE_FALLBACK || "class").toLowerCase();
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_DOWNLOAD = 24;    // candidates downloaded per round
const MAX_TO_VISION = 10;   // photos shown to the vision model per round
const MIN_SIDE = 400;       // ignore thumbnails smaller than this
const MAX_UPSCALE = 3;      // never enlarge a photo more than this (a small photo is placed smaller instead of being rejected)
const FILL = 0.9;           // the product fills at most 90% of the canvas
const BG_TOL = 30;          // how far a pixel may differ from the background colour to count as background
const WORK_MAX = 1800;      // working size of a downloaded photo (the output only needs 1440px)
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
const flat = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
    }));
    return out;
}

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
    // the words that identify the product line: brand, series, and every code with a digit (HX8, 5W-30, R3, 320 ...)
    const words = short.split(/\s+/).filter(Boolean);
    const must = [...new Set(words.filter((w, i) => i <= 1 || /\d/.test(w)).map(flat).filter(Boolean))];
    const tokens = [...new Set(words.map(flat).filter((t) => t.length >= 2))];
    return { title, brand: T(d.b), core, short, size, litres, cls: classOf(litres), key, must, tokens };
}

// does this text name the product line / the pack size?
const lineMatch = (text, n) => n.must.length > 0 && (() => { const h = flat(text); return n.must.every((t) => h.includes(t)); })();
function sizeMatch(text, n) {
    if (!n.key) return false;
    const t = String(text || "").toLowerCase().replace(/\b(litres?|liters?|ltrs?|ltr)\b/g, "l").replace(/\s+/g, "");
    return new RegExp(`(^|[^0-9.])${n.key.replace(".", "\\.")}(?![a-z0-9])`).test(t);
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

// Looks at a 3px band around the photo. Returns { mean:[r,g,b], plain } where plain = the band is mostly one light colour.
function borderInfo(data, w, h) {
    const B = Math.min(3, Math.max(1, (Math.min(w, h) >> 3)));
    const px = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (x < B || y < B || x >= w - B || y >= h - B) { const o = (y * w + x) * 3; px.push(data[o], data[o + 1], data[o + 2]); }
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
    return { mean, plain: near / n >= 0.8 && luma >= 190 };
}

// Download one image. Returns { png (max 1800px), jpg (768px for the vision model), w, h, plain } or null.
async function fetchImage(url, { minSide = 0, timeout = 15000, referer = "" } = {}) {
    if (!url || !safeRemote(url)) return null;
    try {
        const res = await fetch(url, {
            signal: AbortSignal.timeout(timeout),
            redirect: "follow",
            headers: {
                "User-Agent": BROWSER_UA,
                Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                "Accept-Language": "en-IN,en;q=0.9",
                ...(referer ? { Referer: referer } : {}),
            },
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

// shop image URLs often point to a thumbnail; ask for the big version first and keep the original as a fallback
function upgradeUrl(u) {
    try {
        const h = new URL(u).hostname;
        if (/(media-amazon\.com|ssl-images-amazon\.com)$/.test(h)) {
            const big = u.replace(/\._[A-Za-z0-9_,%-]+_\.(jpg|jpeg|png|webp)/i, ".$1");
            if (big !== u) return { url: big, alt: u };
        }
        if (/flixcart\.com$/.test(h)) {
            const big = u.replace(/\/image\/\d+\/\d+\//, "/image/832/832/");
            if (big !== u) return { url: big, alt: u };
        }
    } catch { /* keep as is */ }
    return { url: u, alt: null };
}

async function downloadCandidate(c) {
    const opt = { minSide: MIN_SIDE, timeout: 12000, referer: c.page || "" };
    return (await fetchImage(c.url, opt)) || (c.alt ? await fetchImage(c.alt, opt) : null);
}

/* ---------------------------------- 1. search ---------------------------------- */
// Photos from stock sites are watermarked, so they are never used.
const BAD_DOMAINS = /(alamy|shutterstock|gettyimages|dreamstime|istockphoto|123rf|depositphotos|adobestock|vecteezy|freepik|pngtree|pngwing|clipart|pinimg)/i;
// Shops and brand sites that usually have clean packshots of technical products.
const GOOD_DOMAINS = /(amazon|flipkart|flixcart|indiamart|shell\.|jiomart|bigbasket|boodmo|tradeindia|moglix|industrybuying|zoro|grainger)/i;

async function serper(path, q, num) {
    const res = await fetch(`https://google.serper.dev/${path}`, {
        method: "POST",
        headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ q, num, gl: SEARCH_COUNTRY }),
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`search HTTP ${res.status}`);
    return res.json();
}

async function serperImages(q) {
    const j = await serper("images", q, 10);
    return (j.images || []).map((i) => ({
        url: i.imageUrl, page: i.link, title: i.title || "", domain: i.domain || i.source || hostOf(i.link),
        w: Number(i.imageWidth) || 0, h: Number(i.imageHeight) || 0,
    }));
}

async function serperWeb(q) {
    const j = await serper("search", q, 8);
    return (j.organic || []).map((r) => ({ link: r.link, title: r.title || "" }));
}

// ---- main product photo of a shop / brand page (og:image, twitter:image, JSON-LD Product image)
function extractPageImages(html, base) {
    const out = [];
    const metas = html.match(/<meta\b[^>]*>/gi) || [];
    for (const m of metas) {
        const key = ((m.match(/(?:property|name)=["']([^"']+)["']/i) || [])[1] || "").toLowerCase();
        if (/^(og:image(:secure_url|:url)?|twitter:image(:src)?)$/.test(key)) {
            const c = (m.match(/content=["']([^"']+)["']/i) || [])[1];
            if (c) out.push(c);
        }
    }
    const walk = (o) => {
        if (Array.isArray(o)) return o.forEach(walk);
        if (!o || typeof o !== "object") return;
        if (/Product/i.test([].concat(o["@type"] || []).join(",")) && o.image) {
            [].concat(o.image).forEach((i) => out.push(typeof i === "string" ? i : i?.url));
        }
        Object.values(o).forEach((v) => { if (v && typeof v === "object") walk(v); });
    };
    for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try { walk(JSON.parse(m[1])); } catch { /* ignore broken JSON-LD */ }
    }
    const urls = [];
    for (const u of out) {
        if (!u || typeof u !== "string") continue;
        try {
            const abs = new URL(u.replace(/&amp;/g, "&"), base).toString();
            if (safeRemote(abs) && !/logo|sprite|favicon|placeholder|default[-_]image/i.test(abs) && !urls.includes(abs)) urls.push(abs);
        } catch { /* skip */ }
    }
    return urls;
}

async function fetchPageImages(r) {
    try {
        const res = await fetch(r.link, {
            signal: AbortSignal.timeout(8000),
            redirect: "follow",
            headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-IN,en;q=0.9" },
        });
        if (!res.ok) return [];
        const type = res.headers.get("content-type") || "";
        if (type && !/html/i.test(type)) return [];
        const html = (await res.text()).slice(0, 1_500_000);
        const urls = extractPageImages(html, res.url || r.link);
        const pageTitle = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || "";
        const title = `${r.title} ${pageTitle}`.replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
        return urls.slice(0, 3).map((u) => ({ url: u, page: r.link, title, domain: hostOf(r.link), w: 0, h: 0 }));
    } catch { return []; }
}

async function collectPageCandidates(queries) {
    const settled = await Promise.allSettled(queries.map(serperWeb));
    const links = [], seenLinks = new Set();
    for (const s of settled) {
        if (s.status !== "fulfilled") continue;
        for (const r of s.value.slice(0, 3)) {
            if (!r.link || seenLinks.has(r.link) || !safeRemote(r.link) || BAD_DOMAINS.test(r.link)) continue;
            seenLinks.add(r.link);
            links.push(r);
        }
    }
    const pages = await mapLimit(links.slice(0, 12), 6, fetchPageImages);
    return pages.flat();
}

const sizeImageQueries = (n) => [`${n.short} ${n.size}`, `${n.core} ${n.size}`, `${n.short} ${n.size} site:amazon.in`, `${n.short} ${n.size} site:flipkart.com`];
const lineImageQueries = (n) => [n.short, `${n.short} pack`, `${n.short} site:amazon.in`, `${n.short} site:flipkart.com`, `${n.short} site:indiamart.com`];
const webQueries = (n, withSize) => {
    const b = withSize && n.size ? `${n.short} ${n.size}` : n.short;
    return [`${b} site:flipkart.com`, `${b} site:indiamart.com`, `${b} site:amazon.in`, `${b} buy online india`];
};

// Score a hit by how many product words it names, whether its title names the product line and the size.
function scoreHit(c, n) {
    const h = flat(`${c.title} ${c.page || ""} ${c.url}`);
    let s = n.tokens.length ? n.tokens.filter((t) => h.includes(t)).length / n.tokens.length : 0;
    if (c.titleLine) s += 0.5;
    if (c.titleSize) s += 0.3;
    if (GOOD_DOMAINS.test(c.domain) || GOOD_DOMAINS.test(c.url)) s += 0.15;
    return s;
}

// Search both sources, rank the hits, download the best, keep photos with a plain light background.
async function getCandidates(n, imageQueries, pageQueries, seen, stats) {
    const [imgSettled, pageCands] = await Promise.all([
        Promise.allSettled(imageQueries.map(serperImages)),
        collectPageCandidates(pageQueries).catch(() => []),
    ]);
    if (imgSettled.every((s) => s.status === "rejected") && !pageCands.length) throw new Error(imgSettled[0].reason?.message || "image search failed");

    const raw = [...pageCands, ...imgSettled.flatMap((s) => (s.status === "fulfilled" ? s.value : []))];
    const found = [];
    for (const c of raw) {
        if (!c?.url || seen.has(c.url) || !safeRemote(c.url)) continue;
        if (BAD_DOMAINS.test(c.domain) || BAD_DOMAINS.test(c.url)) continue;
        if (c.w && c.h && Math.min(c.w, c.h) < MIN_SIDE) continue;
        seen.add(c.url);
        const up = upgradeUrl(c.url);
        const text = `${c.title} ${c.page || ""}`;
        const item = { ...c, url: up.url, alt: up.alt, titleLine: lineMatch(text, n), titleSize: sizeMatch(c.title, n) };
        item.score = scoreHit(item, n);
        found.push(item);
    }
    found.sort((a, b) => b.score - a.score);

    const batch = found.slice(0, MAX_DOWNLOAD);
    const downloaded = await mapLimit(batch, 8, async (c) => ({ ...c, img: await downloadCandidate(c) }));
    const usable = downloaded.filter((c) => c.img);
    const plain = usable.filter((c) => c.img.plain);
    stats.found += found.length; stats.tried += batch.length; stats.downloaded += usable.length; stats.plain += plain.length;
    return plain.slice(0, MAX_TO_VISION);
}

/* ---------------------------------- 2. verify (judge only, never edits) ---------------------------------- */
const VISION_INSTRUCTIONS = `You are a product-identification expert for an industrial / automotive e-commerce catalogue (lubricants, coolants, fluids, parts).
You are given numbered photos found on the web for ONE target product, and sometimes an "owner photo" that is the ground truth.
Each photo may come with the title of the web page it was found on. The title says what the listing claims to sell; the photo shows what is really there.
Identity can be established by the printed label OR by a listing title that clearly names the target product, as long as the photo does not visibly contradict it
(a different brand, a different product family, or a clearly different variant code / viscosity printed on the label).

For EVERY numbered photo decide:
- brand_family: true if the pack visibly belongs to the target brand and product family (for example Shell Helix), whatever the variant code.
- variant_conflict: true ONLY if the printed label is readable and clearly shows a different variant code, series, viscosity grade or product type than the target (for example HX5 instead of HX7, 15W-40 instead of 5W-30). If the label is unreadable or matches, false.
- same_line: true if the label itself matches the target brand, series, every code in the target name and the viscosity grade.
- same_size: true if the pack size PRINTED on the photo equals the target pack size (1 L = 1000 ml; 900 ml is not 1 L; 3.5 L is not 4 L). If the target has no pack size, true. If you cannot read the size, false.
- size_conflict: true ONLY if a printed pack size is readable and clearly different from the target.
- container_class: the kind of container in the photo: "small" (hand-size bottle up to about 1.5 L), "bottle" (2 to 6 L bottle or jerrycan with a handle), "can" (7 to 25 L pail or can), "drum" (large barrel of 50 L or more), "other".
- clean_view: true if the whole product is visible, not heavily cropped, reasonably sharp, and the main label faces the camera (a slight angle is fine; the label does not have to be readable).
- single_product: false for collages, multi-pack bundles, sets of different products, or lifestyle scenes.
- watermark: true if there is a visible watermark, shop logo stamp, price badge, sale sticker or any overlay text that is not part of the pack.
- quality: 1-10 for sharpness, resolution and how clean the photo is as a catalogue image.
- reason: a few words.

Return ONLY JSON:
{"matches":[{"index":0,"brand_family":true,"variant_conflict":false,"same_line":true,"same_size":true,"size_conflict":false,"container_class":"small","clean_view":true,"single_product":true,"watermark":false,"quality":8,"reason":"short"}]}`;

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
        content.push({ type: "text", text: `Photo ${i} (from ${c.domain || "web"}). Page title: "${T(c.title, 160) || "unknown"}"` });
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

// Returns { exact: [cand...], approx: [cand...], rej } each list best first. rej counts why photos were dropped.
async function rankCandidates(d, n, owner, cands) {
    const verdict = await judgePhotos(d, n, owner, cands);
    const rej = { brand: 0, variant: 0, notClean: 0, watermark: 0, quality: 0, packType: 0 };
    const exact = [], approxClass = [], approxAny = [];
    const rows = (verdict.matches || []).filter((m) => m && cands[Number(m.index)]);

    for (const m of rows) {
        const c = cands[Number(m.index)];
        console.log(`[catalogProductImage]   photo ${m.index} ${c.domain}: line=${m.same_line} family=${m.brand_family} conflict=${m.variant_conflict} size=${m.same_size} class=${m.container_class} clean=${m.clean_view} q=${m.quality} titleLine=${c.titleLine} - ${T(m.reason, 80)}`);
        const q = Number(m.quality) || 0;
        const lineOk = m.same_line === true || (m.brand_family === true && m.variant_conflict !== true && c.titleLine);
        if (!lineOk) { if (m.brand_family === false && m.same_line !== true) rej.brand++; else rej.variant++; continue; }
        if (m.clean_view !== true || m.single_product === false) { rej.notClean++; continue; }
        if (m.watermark === true) { rej.watermark++; continue; }

        const sizeOk = m.same_size === true || (c.titleSize === true && m.size_conflict !== true);
        const item = { c, q, line: c.titleLine ? 1 : 0, px: c.img.w * c.img.h };
        if (sizeOk) { if (q >= 4) exact.push(item); else rej.quality++; continue; }
        if (q < 5) { rej.quality++; continue; }
        if (FALLBACK === "off") rej.packType++;
        else if (n.cls && m.container_class === n.cls) approxClass.push(item);
        else if (FALLBACK === "any") approxAny.push(item);
        else rej.packType++;
    }
    const best = (a, b) => (b.q - a.q) || (b.line - a.line) || (b.px - a.px);
    return {
        exact: exact.sort(best).map((i) => i.c),
        approx: [...approxClass.sort(best), ...approxAny.sort(best)].map((i) => i.c),
        rej,
    };
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
    if (painted < n * 0.01) return null;

    return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// Returns the final PNG, or null when the photo is unusable.
// A small photo is not rejected: it is placed smaller on the canvas (never enlarged more than MAX_UPSCALE).
async function toCatalogPng(img) {
    const clean = await whitenBackground(img.png);
    if (!clean) return null;

    const { data: trimmed, info } = await sharp(clean).trim({ background: "#ffffff", threshold: 10 }).toBuffer({ resolveWithObject: true });
    if (info.width < 60 || info.height < 60) return null;

    const boxW = Math.round(OUT_W * FILL), boxH = Math.round(OUT_H * FILL);
    const scale = Math.min(boxW / info.width, boxH / info.height, MAX_UPSCALE);
    const inner = await sharp(trimmed)
        .resize({ width: Math.max(1, Math.round(info.width * scale)), height: Math.max(1, Math.round(info.height * scale)), fit: "fill", kernel: "lanczos3" })
        .png().toBuffer();

    return sharp({ create: { width: OUT_W, height: OUT_H, channels: 3, background: "#ffffff" } })
        .composite([{ input: inner, gravity: "centre" }])
        .png({ compressionLevel: 9 })
        .toBuffer();
}

async function firstUsable(list, stats) {
    for (const c of list) {
        const png = await toCatalogPng(c.img);
        if (png) return { png, cand: c };
        stats.unusable++;
    }
    return null;
}

function summarise(s) {
    if (!s.tried) return "the web search found no usable photos";
    const parts = [];
    const add = (k, t) => { if (k > 0) parts.push(`${k} ${t}`); };
    add(s.tried - s.downloaded, "could not be downloaded");
    add(s.downloaded - s.plain, "had no plain background");
    add(s.rej.brand, "were a different brand or product");
    add(s.rej.variant, "were a different variant");
    add(s.rej.packType, "had a different pack type");
    add(s.rej.notClean + s.rej.watermark, "were not clean (cropped, collage or watermark)");
    add(s.rej.quality, "were low quality");
    add(s.unusable, "could not be processed");
    return `tried ${s.tried} photos: ${parts.join(", ") || "none passed"}`;
}

// data = cleaned draft data. refUrl = the owner's own photo (or null); it is only used as ground truth
// to verify the web photos, and as a last resort if it is already clean.
export async function generateProductImage({ data, refUrl }) {
    if (!SERPER_KEY) throw new JobError("Product photo search is not set up on the server.", false);
    if (T(data.n).length < 2 || !T(data.b)) throw new JobError("Add the product name and brand first.", false);

    const n = nameParts(data);
    const owner = refUrl ? await fetchImage(refUrl) : null;
    const seen = new Set();
    const stats = { found: 0, tried: 0, downloaded: 0, plain: 0, unusable: 0, rej: { brand: 0, variant: 0, notClean: 0, watermark: 0, quality: 0, packType: 0 } };

    const rounds = [];
    if (n.size) rounds.push({ name: "exact size", img: sizeImageQueries(n), web: webQueries(n, true) });
    rounds.push({ name: "product line", img: lineImageQueries(n), web: webQueries(n, false) });

    let approxPool = [];
    for (const [i, round] of rounds.entries()) {
        const cands = await getCandidates(n, round.img, round.web, seen, stats);
        let exact = [], approx = [];
        if (cands.length) {
            const r = await rankCandidates(data, n, owner, cands);
            exact = r.exact; approx = r.approx;
            Object.keys(stats.rej).forEach((k) => { stats.rej[k] += r.rej[k]; });
        }
        console.log(`[catalogProductImage] "${n.title}" round ${i + 1} (${round.name}): ${cands.length} plain-background photos to vision, accepted ${exact.length} exact / ${approx.length} other size`);

        const hit = await firstUsable(exact, stats);
        if (hit) {
            console.log(`[catalogProductImage] "${n.title}": original photo (exact size) from ${hit.cand.page || hit.cand.url}`);
            return hit.png;
        }
        approxPool = approxPool.concat(approx);
    }

    // same product line, but not the exact pack size
    const approxHit = await firstUsable(approxPool, stats);
    if (approxHit) {
        console.log(`[catalogProductImage] "${n.title}": original photo of the same line, different pack size, from ${approxHit.cand.page || approxHit.cand.url}`);
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

    const why = summarise(stats);
    console.log(`[catalogProductImage] "${n.title}": no usable photo (${why})`);
    throw new JobError(`Could not find a clean original photo of this exact product (${why}). Please upload one.`, false);
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