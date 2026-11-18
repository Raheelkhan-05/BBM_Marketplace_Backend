// services/catalogProductImage.service.js
// One product -> one clean 3:4 white-background PNG made from the REAL product photo.
// Nothing is generated or redrawn by AI, and nothing is guessed: if the photo cannot be PROVEN to be the exact
// product, the job fails with a clear message.
//
//   1. SEARCH   Google Images (Serper) + the main photo of shop / brand pages (Flipkart, IndiaMART, Amazon ...),
//               round 1 = with the pack size, round 2 = product line only.
//   2. FILTER   download the best title/URL matches, keep photos with a plain light background.
//   3. READ     a vision model BLIND-READS each pack (it is not told which product to expect): brand, printed label
//               text, printed size, container type, photo quality. The CODE then compares that text with the product
//               name: every identifying word / code (HX8, AX5, R3, 5W-30 ...) must be printed on the pack.
//   4. CONFIRM  the best photos are read again at higher resolution, and a second, independent check must say "same".
//               "different" or "unsure" = rejected.
//   5. FINISH   plain background -> pure white (only pixels connected to the photo edge), trim, and centre the
//               untouched product on a pure white 1200x1600 (3:4) canvas.
import OpenAI from "openai";
import sharp from "sharp";
import { supabase } from "../config/supabase.js";

const BUCKET = process.env.CATALOG_IMAGE_BUCKET || "catalog-images";
const SERPER_KEY = process.env.SERPER_API_KEY || "";                      // https://serper.dev
const SEARCH_COUNTRY = process.env.CATALOG_SEARCH_COUNTRY || "in";        // Google "gl" parameter
const VISION_MODEL = process.env.CATALOG_VISION_MODEL || "gpt-4.1-mini";  // any vision-capable chat model
// How the pack size must be proven:
//   "label_or_title" (default) = printed on the pack, OR the shop's title says it AND the container type matches
//   "label"                    = printed on the pack only
const SIZE_EVIDENCE = (process.env.CATALOG_SIZE_EVIDENCE || "label_or_title").toLowerCase();
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_DOWNLOAD = 24;     // candidates downloaded per round
const MAX_TO_VISION = 8;     // photos read per round
const CONFIRM_PER_ROUND = 3; // photos confirmed per round
const CONFIRM_TOTAL = 4;     // photos confirmed per job
const MIN_SIDE = 400;        // ignore thumbnails smaller than this
const MAX_UPSCALE = 3;       // never enlarge a photo more than this (a small photo is placed smaller instead of being rejected)
const FILL = 0.9;            // the product fills at most 90% of the canvas
const BG_TOL = 30;           // how far a pixel may differ from the background colour to count as background
const WORK_MAX = 1800;       // working size of a downloaded photo (the output only needs 1440px)
const READ_SIDE = 896;       // photo size for the first read
const CONFIRM_SIDE = 1280;   // photo size for the confirmation read
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

/* ---------------------------------- words / names / pack size ---------------------------------- */
// words that describe the kind of product but do not identify the line (a pack may or may not print them)
const GENERIC = new Set([
    "engine", "oil", "oils", "lubricating", "lubricant", "lubricants", "industrial", "heavy", "duty", "diesel", "petrol", "cng",
    "motorcycle", "scooter", "car", "cars", "passenger", "vehicle", "vehicles", "synthetic", "fully", "technology", "mineral",
    "premium", "stroke", "for", "and", "the", "of", "with", "fluid", "gear", "new", "pack", "litre", "liter", "ltr", "l", "ml",
]);

// lower-case words; "5W-30" / "5w 30" / "5W30" all become "5w30"; "4-Stroke" is dropped
function words(text) {
    return String(text || "").toLowerCase()
        .replace(/&/g, " and ")
        .replace(/\b(\d{1,2})\s*w\s*[-/]?\s*(\d{2,3})\b/g, " $1w$2 ")
        .replace(/\b[24]\s*-?\s*stroke\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}
// what was read from a pack, plus joined neighbours ("hx 8" -> "hx8")
function wordSet(text) {
    const w = words(text), s = new Set(w);
    for (let i = 0; i + 1 < w.length; i++) s.add(w[i] + w[i + 1]);
    return s;
}

function productTitle(d) {
    const brand = T(d.b), name = T(d.n);
    return brand && !name.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${name}` : name;
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
    const brandWords = new Set(words(T(d.b)));
    // the words that identify the product line: series names and every code (helix, hx8, 5w30, r3, s2, 320 ...)
    const must = [...new Set(words(short).filter((w) => !brandWords.has(w) && !GENERIC.has(w)))];
    const tokens = [...new Set(words(short).filter((t) => t.length >= 2))];
    return { title, brand: T(d.b), core, short, size, litres, cls: classOf(litres), key, must, tokens };
}

// does this text (a page title) name the product line / the pack size? Used only to RANK photos, never to approve one.
const lineMatch = (text, n) => n.must.length > 0 && (() => { const s = wordSet(text); return n.must.every((t) => s.has(t)); })();
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

// Download one image. Returns { png (max 1800px), jpg (896px for the vision model), w, h, plain } or null.
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
        const jpg = await base.clone().resize({ width: READ_SIDE, height: READ_SIDE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
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
// Shops and brand sites that usually have clean packshots of technical products (used for ranking only).
const GOOD_DOMAINS = /(amazon|flipkart|flixcart|indiamart|shell\.|jiomart|bigbasket|boodmo|tradeindia|moglix|industrybuying|zoro|grainger)/i;

async function serper(job, path, q, num) {
    job.serper += 1;
    const res = await fetch(`https://google.serper.dev/${path}`, {
        method: "POST",
        headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ q, num, gl: SEARCH_COUNTRY }),
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`search HTTP ${res.status}`);
    return res.json();
}

async function serperImages(job, q) {
    const j = await serper(job, "images", q, 10);
    return (j.images || []).map((i) => ({
        url: i.imageUrl, page: i.link, title: i.title || "", domain: i.domain || i.source || hostOf(i.link),
        w: Number(i.imageWidth) || 0, h: Number(i.imageHeight) || 0,
    }));
}

async function serperWeb(job, q) {
    const j = await serper(job, "search", q, 8);
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

async function collectPageCandidates(job, queries) {
    const settled = await Promise.allSettled(queries.map((q) => serperWeb(job, q)));
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

// Score a hit by how many product words it names, whether its title names the product line and the size (ranking only).
function scoreHit(c, n) {
    const h = flat(`${c.title} ${c.page || ""} ${c.url}`);
    let s = n.tokens.length ? n.tokens.filter((t) => h.includes(flat(t))).length / n.tokens.length : 0;
    if (c.titleLine) s += 0.5;
    if (c.titleSize) s += 0.3;
    if (GOOD_DOMAINS.test(c.domain) || GOOD_DOMAINS.test(c.url)) s += 0.15;
    return s;
}

// Search both sources, rank the hits, download the best, keep photos with a plain light background.
async function getCandidates(job, n, imageQueries, pageQueries, seen) {
    const [imgSettled, pageCands] = await Promise.all([
        Promise.allSettled(imageQueries.map((q) => serperImages(job, q))),
        collectPageCandidates(job, pageQueries).catch(() => []),
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
        const item = { ...c, url: up.url, alt: up.alt, titleLine: lineMatch(`${c.title} ${c.page || ""}`, n), titleSize: sizeMatch(c.title, n) };
        item.score = scoreHit(item, n);
        found.push(item);
    }
    found.sort((a, b) => b.score - a.score);

    const batch = found.slice(0, MAX_DOWNLOAD);
    const downloaded = await mapLimit(batch, 8, async (c) => ({ ...c, img: await downloadCandidate(c) }));
    const usable = downloaded.filter((c) => c.img);
    const plain = usable.filter((c) => c.img.plain);
    job.found += found.length; job.tried += batch.length; job.downloaded += usable.length; job.plain += plain.length;
    return plain.slice(0, MAX_TO_VISION);
}

/* ---------------------------------- 2. read + verify ---------------------------------- */
async function askVision(job, system, content) {
    const res = await client().chat.completions.create({
        model: VISION_MODEL,
        response_format: { type: "json_object" },
        ...(/^gpt-4/.test(VISION_MODEL) ? { temperature: 0 } : {}),
        messages: [{ role: "system", content: system }, { role: "user", content }],
    });
    job.calls += 1;
    job.inTok += res?.usage?.prompt_tokens || 0;
    job.outTok += res?.usage?.completion_tokens || 0;
    const raw = res?.choices?.[0]?.message?.content || "{}";
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

const dataUrl = (jpg) => `data:image/jpeg;base64,${jpg.toString("base64")}`;

// The model is NOT told which product to expect, so it cannot "see" what it hopes to see.
const READ_INSTRUCTIONS = `You are an OCR and packaging inspector for a product catalogue. You are NOT told which product to expect.
For EVERY numbered photo, report only what is actually visible on the pack:
- brand: the brand name printed on the pack or shown by its logo (for example Shell, Castrol). "" if none.
- label_text: the words and numbers printed on the FRONT of the pack, in reading order (product name, series, variant codes, viscosity grade, size). Copy exactly what you can read. Never guess, complete or correct partly visible words; leave out anything you cannot read. "" if nothing is readable.
- printed_size: the pack size printed on the pack (for example "1 L", "900 ml", "209 L"), or "" if you cannot read one.
- container_class: "small" (hand-size bottle up to about 1.5 L), "bottle" (2 to 6 L bottle or jerrycan with a handle), "can" (7 to 25 L pail or can), "drum" (large barrel of 50 L or more), "other".
- clean_view: true only if the whole pack is visible, not cropped, reasonably sharp, with the main label facing the camera (a slight angle is fine).
- single_product: false for a collage, a bundle or multi-pack of different products, or a lifestyle scene.
- watermark: true if a shop logo stamp, watermark, price badge, sale sticker or any overlay text that is not part of the pack is visible.
- quality: 1-10 for sharpness and how clean the photo is as a catalogue image.
Return ONLY JSON: {"photos":[{"index":0,"brand":"","label_text":"","printed_size":"","container_class":"small","clean_view":true,"single_product":true,"watermark":false,"quality":7}]}`;

// items = [{ jpg }]. Returns Map(index -> reading).
async function readPacks(job, items) {
    const content = [];
    items.forEach((it, i) => {
        content.push({ type: "text", text: `Photo ${i}:` });
        content.push({ type: "image_url", image_url: { url: dataUrl(it.jpg), detail: "high" } });
    });
    const j = await askVision(job, READ_INSTRUCTIONS, content);
    return new Map((j.photos || []).map((p) => [Number(p.index), p]));
}

// Compare what was READ from the pack with the product name. Deterministic: the model has no say here.
function assess(r, c, n) {
    if (!r) return { ok: false, kind: "unreadable", why: "no reading" };
    const brandRead = flat(r.brand), brandWant = flat(n.brand);
    if (!brandRead) return { ok: false, kind: "unreadable", why: "brand not readable" };
    if (brandWant && !(brandRead.includes(brandWant) || brandWant.includes(brandRead))) return { ok: false, kind: "mismatch", why: `brand is "${T(r.brand, 40)}"` };
    if (!n.must.length) return { ok: false, kind: "unreadable", why: "product name has no identifying words" };

    const label = wordSet(r.label_text);
    if (label.size < 2) return { ok: false, kind: "unreadable", why: "label not readable" };
    const missing = n.must.filter((t) => !label.has(t));
    if (missing.length) return { ok: false, kind: "mismatch", why: `label does not show: ${missing.join(", ")}` };

    if (r.clean_view !== true || r.single_product === false || r.watermark === true) return { ok: false, kind: "notClean", why: "not a clean single front view" };
    if ((Number(r.quality) || 0) < 5) return { ok: false, kind: "quality", why: "low quality" };

    if (n.litres != null) {
        const printed = parseLitres(r.printed_size);
        if (printed != null) {
            if (Math.abs(printed - n.litres) > Math.max(0.001, n.litres * 0.005)) return { ok: false, kind: "size", why: `printed size is ${T(r.printed_size, 20)}` };
        } else if (SIZE_EVIDENCE === "label") {
            return { ok: false, kind: "size", why: "pack size not readable" };
        } else if (!(c.titleSize && r.container_class === n.cls)) {
            return { ok: false, kind: "size", why: "pack size not proven" };
        }
    }
    return { ok: true, why: "label matches" };
}

// Second, independent check. It can only confirm; "different" or "unsure" rejects the photo.
const CHECK_INSTRUCTIONS = `You verify catalogue photos. You get a TARGET product and ONE photo.
Answer "same" only if the pack in the photo is clearly the target product: same brand, same product series, same variant words and codes and the same viscosity grade as the target name. The pack must not show any extra variant word or code that the target name lacks (for example AH, AZ, ECT, Professional, Ultra, Plus) and must not lack one that the target has. If a pack size is printed it must equal the target size; if no size is printed, ignore the size.
Answer "different" if the pack is another product, series, variant, viscosity grade, brand or size.
Answer "unsure" if you cannot read enough of the label to be certain. Never guess.
Return ONLY JSON: {"verdict":"same|different|unsure","evidence":"the words you can read on the pack that decide it"}`;

async function confirmPhoto(job, n, c) {
    // 1) blind read again, bigger, and compare in code
    const big = await sharp(c.img.png).resize({ width: CONFIRM_SIDE, height: CONFIRM_SIDE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    const read = (await readPacks(job, [{ jpg: big }])).get(0);
    const a = assess(read, c, n);
    if (!a.ok) return { ok: false, why: `second reading: ${a.why}` };
    // 2) informed check, may only confirm
    const v = await askVision(job, CHECK_INSTRUCTIONS, [
        { type: "text", text: `TARGET PRODUCT: "${n.title}"\nTARGET PACK SIZE: ${n.size || "not given"}` },
        { type: "image_url", image_url: { url: dataUrl(c.img.jpg), detail: "high" } },
    ]);
    if (v.verdict !== "same") return { ok: false, why: `second check says ${v.verdict || "unsure"}: ${T(v.evidence, 100)}` };
    return { ok: true, why: T(v.evidence, 100) };
}

// First reading of up to 8 photos. Returns the ones that pass, best first.
async function screenPhotos(job, n, cands) {
    const reads = await readPacks(job, cands.map((c) => ({ jpg: c.img.jpg })));
    const good = [];
    cands.forEach((c, i) => {
        const r = reads.get(i);
        const a = assess(r, c, n);
        console.log(`[catalogProductImage]   photo ${i} ${c.domain}: brand="${T(r?.brand, 20)}" label="${T(r?.label_text, 70)}" size="${T(r?.printed_size, 12)}" -> ${a.ok ? "ok" : a.why}`);
        if (a.ok) good.push({ c, q: Number(r.quality) || 0 });
        else job.rej[a.kind] += 1;
    });
    good.sort((a, b) => (b.q - a.q) || (Number(b.c.titleLine) - Number(a.c.titleLine)) || (b.c.img.w * b.c.img.h - a.c.img.w * a.c.img.h));
    return good.map((g) => g.c);
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

/* ---------------------------------- main ---------------------------------- */
function summarise(j) {
    if (!j.tried) return "the web search found no usable photos";
    const parts = [];
    const add = (k, t) => { if (k > 0) parts.push(`${k} ${t}`); };
    add(j.tried - j.downloaded, "could not be downloaded");
    add(j.downloaded - j.plain, "had no plain background");
    add(j.rej.unreadable, "had a label that could not be read clearly");
    add(j.rej.mismatch, "showed a different product or variant");
    add(j.rej.size, "had a different or unproven pack size");
    add(j.rej.notClean, "were not a clean front view");
    add(j.rej.quality, "were low quality");
    add(j.rej.confirm, "failed the second check");
    add(j.unusable, "could not be processed");
    return `checked ${j.tried} photos: ${parts.join(", ") || "none passed"}`;
}

// data = cleaned draft data. refUrl = the owner's own uploaded photo (or null), used only as a last resort.
export async function generateProductImage({ data, refUrl }) {
    if (!SERPER_KEY) throw new JobError("Product photo search is not set up on the server.", false);
    if (T(data.n).length < 2 || !T(data.b)) throw new JobError("Add the product name and brand first.", false);

    const n = nameParts(data);
    const job = {
        serper: 0, calls: 0, inTok: 0, outTok: 0, confirms: 0,
        found: 0, tried: 0, downloaded: 0, plain: 0, unusable: 0,
        rej: { unreadable: 0, mismatch: 0, size: 0, notClean: 0, quality: 0, confirm: 0 },
    };
    const seen = new Set();
    const logCost = () => {
        const usd = job.serper * 0.001 + job.inTok * 0.4e-6 + job.outTok * 1.6e-6;
        console.log(`[catalogProductImage] "${n.title}": cost ~$${usd.toFixed(4)} (${job.serper} search credits, ${job.calls} vision calls, ${job.inTok} in / ${job.outTok} out tokens)`);
    };

    const rounds = [];
    if (n.size) {
        rounds.push({
            name: "exact size",
            img: [`${n.short} ${n.size}`, `${n.core} ${n.size}`, `${n.short} ${n.size} site:amazon.in`, `${n.short} ${n.size} site:flipkart.com`],
            web: [`${n.short} ${n.size} site:flipkart.com`, `${n.short} ${n.size} site:indiamart.com`, `${n.short} ${n.size} site:amazon.in`, `${n.short} ${n.size} buy online india`],
        });
        rounds.push({
            name: "product line",
            img: [n.short, `${n.short} site:amazon.in`, `${n.short} site:flipkart.com`],
            web: [`${n.short} site:indiamart.com`, `${n.short} india`],
        });
    } else {
        rounds.push({
            name: "product line",
            img: [n.short, `${n.short} pack`, `${n.short} site:amazon.in`, `${n.short} site:flipkart.com`],
            web: [`${n.short} site:flipkart.com`, `${n.short} site:indiamart.com`, `${n.short} buy online india`],
        });
    }

    for (const [i, round] of rounds.entries()) {
        const cands = await getCandidates(job, n, round.img, round.web, seen);
        const good = cands.length ? await screenPhotos(job, n, cands) : [];
        console.log(`[catalogProductImage] "${n.title}" round ${i + 1} (${round.name}): ${cands.length} plain-background photos read, ${good.length} matched the label`);

        for (const c of good.slice(0, CONFIRM_PER_ROUND)) {
            if (job.confirms >= CONFIRM_TOTAL) break;
            job.confirms += 1;
            const v = await confirmPhoto(job, n, c);
            if (!v.ok) { job.rej.confirm += 1; console.log(`[catalogProductImage]   rejected ${c.page || c.url}: ${v.why}`); continue; }
            const png = await toCatalogPng(c.img);
            if (!png) { job.unusable += 1; continue; }
            console.log(`[catalogProductImage] "${n.title}": VERIFIED original photo from ${c.page || c.url} (${v.why})`);
            logCost();
            return png;
        }
    }

    // last resort: the owner's own uploaded photo, if it already has a plain background (it is the seller's own photo, not a guess)
    const owner = refUrl ? await fetchImage(refUrl) : null;
    if (owner?.plain) {
        const png = await toCatalogPng(owner);
        if (png) {
            console.log(`[catalogProductImage] "${n.title}": no verified web photo, used the uploaded photo`);
            logCost();
            return png;
        }
    }

    const why = summarise(job);
    console.log(`[catalogProductImage] "${n.title}": NO photo could be verified (${why})`);
    logCost();
    throw new JobError(`Could not verify a photo of this exact product, so none was used (${why}). Please upload one.`, false);
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