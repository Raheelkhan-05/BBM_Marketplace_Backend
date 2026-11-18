// services/catalogProductImage.service.js
// One product -> one clean 3:4 white-background PNG.
//
// Pipeline
//   1. RESEARCH  search the web for the real product, download candidate photos, let a vision model
//                pick the ones that are truly the same product and write down its packaging details
//                (container, shape, colours, label layout, printed text, typography).
//   2. GENERATE  images.edit with the best real photos as reference (keeps the real pack design),
//                plus the researched packaging spec in the prompt.
//                If nothing reliable is found, it falls back to the old behaviour
//                (own photo -> edit, no photo -> generate from text).
//   3. FINISH    the model returns 1024x1536 (2:3). It is placed on a pure white 1200x1600 (3:4) canvas, never stretched.
import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import { supabase } from "../config/supabase.js";

const MODEL = process.env.CATALOG_IMAGE_MODEL || "gpt-image-2";
const QUALITY = process.env.CATALOG_IMAGE_QUALITY || "medium"; // low | medium | high
const FIDELITY = process.env.CATALOG_IMAGE_INPUT_FIDELITY || "high";
const BUCKET = process.env.CATALOG_IMAGE_BUCKET || "catalog-images";
const GEN_SIZE = "1024x1536";
const MAX_REF_BYTES = 15 * 1024 * 1024;

// ---- web research settings ----
const RESEARCH_ON = process.env.CATALOG_WEB_RESEARCH !== "off";          // set to "off" to disable research
const SERPER_KEY = process.env.SERPER_API_KEY || "";                      // https://serper.dev (Google Images API)
const SEARCH_COUNTRY = process.env.CATALOG_SEARCH_COUNTRY || "in";        // Google "gl" parameter
const VISION_MODEL = process.env.CATALOG_VISION_MODEL || "gpt-4.1-mini";  // any vision-capable chat model
const RESEARCH_BUDGET_MS = Number(process.env.CATALOG_RESEARCH_TIMEOUT_MS) || 45_000;
const MAX_CANDIDATES = 8;   // photos shown to the vision model
const MAX_WEB_REFS = 2;     // web photos sent to the image model (besides the owner's own photo)
const MIN_SIDE = 300;       // ignore thumbnails smaller than this

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

// Download + normalise one image. Returns { png, jpg } (png = max 1536px for the image model, jpg = 768px for the vision model)
// or null if the file is unusable. minSide > 0 rejects thumbnails.
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
        if (Number(res.headers.get("content-length") || 0) > MAX_REF_BYTES) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_REF_BYTES) return null;

        const meta = await sharp(buf).metadata();
        if (minSide && Math.min(meta.width || 0, meta.height || 0) < minSide) return null;

        const base = sharp(buf).rotate().flatten({ background: "#ffffff" });
        const png = await base.clone().resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).png().toBuffer();
        const jpg = await base.clone().resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
        return { png, jpg };
    } catch { return null; }
}

// The owner's own photo (from the draft). Returns a PNG buffer or null.
async function loadReference(url) {
    const img = await fetchImage(url);
    return img ? img.png : null;
}

/* ---------------------------------- prompt helpers ---------------------------------- */
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

/* ---------------------------------- 1. web research ---------------------------------- */
// Photos from stock sites are watermarked, so they are never used as references.
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
    return (j.images || []).map((i) => ({ url: i.imageUrl, page: i.link, title: i.title, domain: i.domain || i.source || "" }));
}

async function searchCandidates(d) {
    const title = productTitle(d);
    const extra = [T(d.grade, 60), T(d.model, 60), Number(d.ps) > 0 && T(d.u) ? `${T(d.ps, 20)} ${T(d.u, 40)}` : ""].filter(Boolean).join(" ");
    const queries = [`${title} ${extra}`.trim(), `${title} ${extra} pack front view`.trim()];

    const settled = await Promise.allSettled(queries.map(serperImages));
    const seen = new Set(), out = [];
    // interleave the two result lists so both queries contribute
    const lists = settled.map((s) => (s.status === "fulfilled" ? s.value : []));
    for (let i = 0; i < 10; i++) {
        for (const list of lists) {
            const c = list[i];
            if (!c?.url || seen.has(c.url) || !safeRemote(c.url)) continue;
            if (BAD_DOMAINS.test(c.domain) || BAD_DOMAINS.test(c.url)) continue;
            seen.add(c.url);
            out.push(c);
        }
    }
    return out.slice(0, 14);
}

const VISION_INSTRUCTIONS = `You are a packaging and product-identification expert for an e-commerce catalogue.
You are given numbered photos found on the web for ONE target product, and sometimes an "owner photo" that is the ground truth.

TASK
1. For every numbered photo decide if it shows EXACTLY the target product: same brand, same product name AND same variant / size / pack type where those are known. A different flavour, size, generation or a competing brand is NOT the same product. Do not guess; if unsure, same_product = false.
2. Judge the usefulness as a reference: a single product, front facing, whole product visible, sharp, not a collage, not a lifestyle scene, no heavy watermark, no price badges.
3. Choose the best photos (max ${MAX_WEB_REFS}, best first) from those that are the same product.
4. Describe the real packaging using ONLY the photos that are the same product (and the owner photo). Never invent details. Use "" for anything you cannot see clearly.

Return ONLY JSON:
{
  "matches": [ { "index": 0, "same_product": true, "clean_front_view": true, "quality": 8, "reason": "short" } ],
  "best": [0],
  "spec": {
    "container": "bottle | jar | pouch | box | can | tube | bag | sachet | blister | other, plus size class",
    "shape": "overall silhouette and proportions (e.g. tall slim cylinder, 2:1 height to width, shoulder, neck)",
    "material_finish": "glossy / matte / transparent / metallic / paper etc.",
    "closure": "cap, lid, nozzle, zipper, tear notch: shape and colour",
    "colors": "main packaging colours with approximate hex codes and where each is used",
    "label_layout": "where logo, product name, variant, claims, size and graphics sit, top to bottom",
    "printed_text": "the exact legible words and numbers on the FRONT of the pack, in reading order",
    "typography": "font style of brand and product name (serif / sans / script / bold / condensed), text colour, text case",
    "logo": "logo shape, colours and position",
    "distinct_features": "anything else that makes this pack recognisable (stripes, windows, embossing, illustrations)"
  }
}
If no photo is the same product, return "best": [] and a "spec" with all values "".`;

async function analysePhotos(d, owner, cands) {
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

function specToText(spec) {
    if (!spec || typeof spec !== "object") return "";
    const labels = {
        container: "Container", shape: "Shape and proportions", material_finish: "Material / finish", closure: "Closure",
        colors: "Colours", label_layout: "Label layout", printed_text: "Exact printed text on the front",
        typography: "Typography", logo: "Logo", distinct_features: "Distinct features",
    };
    return Object.entries(labels)
        .map(([k, label]) => (T(spec[k], 400) ? `- ${label}: ${T(spec[k], 400)}` : ""))
        .filter(Boolean).join("\n");
}

// Returns { images: [png...], spec: "text" , sources: [...] } or null when nothing reliable was found.
async function researchProduct(d, ownerPng) {
    if (!RESEARCH_ON || !SERPER_KEY) return null;
    if (T(d.n).length < 2 || !T(d.b)) return null;

    const found = await searchCandidates(d);
    if (!found.length) return null;

    // download in parallel, keep the first MAX_CANDIDATES usable ones
    const downloaded = await Promise.all(found.map(async (c) => ({ ...c, img: await fetchImage(c.url, { minSide: MIN_SIDE, timeout: 8000 }) })));
    const cands = downloaded.filter((c) => c.img).slice(0, MAX_CANDIDATES);
    if (!cands.length) return null;

    const owner = ownerPng ? { jpg: await sharp(ownerPng).resize({ width: 768, height: 768, fit: "inside" }).jpeg({ quality: 82 }).toBuffer() } : null;
    const verdict = await analysePhotos(d, owner, cands);

    const okIdx = new Set(
        (verdict.matches || []).filter((m) => m?.same_product === true && Number(m?.quality) >= 5).map((m) => Number(m.index)),
    );
    const order = (Array.isArray(verdict.best) ? verdict.best : []).map(Number).filter((i) => okIdx.has(i) && cands[i]);
    // if the model forgot "best", fall back to the highest quality matches
    if (!order.length) {
        (verdict.matches || [])
            .filter((m) => okIdx.has(Number(m.index)) && cands[Number(m.index)])
            .sort((a, b) => Number(b.quality) - Number(a.quality))
            .forEach((m) => order.push(Number(m.index)));
    }
    const chosen = [...new Set(order)].slice(0, MAX_WEB_REFS).map((i) => cands[i]);

    // No photo is the same product and the owner has no photo -> the spec would be a guess, so drop it.
    if (!chosen.length && !ownerPng) return null;

    return {
        images: chosen.map((c) => c.img.png),
        spec: specToText(verdict.spec),
        sources: chosen.map((c) => c.page || c.url),
    };
}

// research must never block or break generation
async function safeResearch(d, ownerPng) {
    try {
        return await Promise.race([
            researchProduct(d, ownerPng),
            new Promise((resolve) => setTimeout(() => resolve(null), RESEARCH_BUDGET_MS)),
        ]);
    } catch (e) {
        console.warn("[catalogProductImage] research skipped:", e?.message || e);
        return null;
    }
}

/* ---------------------------------- 2. prompt ---------------------------------- */
export function buildPrompt(d, hasRef, spec = "", refCount = 1) {
    const title = productTitle(d);
    const facts = productFacts(d);

    const refText = refCount > 1
        ? `${refCount} reference photos of the real product are attached; the FIRST is the primary ground truth, the others show the same product from other sources. Treat them as ground truth: keep the product's exact shape, proportions, container type, cap/closure, packaging design, colours, logo, label layout, typography and every printed word and number identical. Use them only to learn how the product looks: do NOT copy their backgrounds, watermarks, price badges, shadows or any extra objects. Only improve the presentation (clean white background, even studio lighting, sharper detail). Do not redesign, restyle or invent anything.`
        : "A reference photo of the real product is attached. Treat it as the ground truth: keep the product's exact shape, proportions, packaging design, colours, logo, label layout and every printed word and number identical. Use it only to learn how the product looks: do NOT copy its background, watermark or any extra objects. Only improve the presentation (clean white background, even studio lighting, sharper detail). Do not redesign, restyle or invent anything.";

    return [
        `Create a professional e-commerce catalogue photograph of this exact retail product: "${title}".`,
        facts.length ? `Known details: ${facts.join("; ")}.` : "",
        hasRef
            ? refText
            : "Reproduce the real, current retail packaging of this product as faithfully as you can: the genuine shape, colour scheme, logo, typography and label layout of the brand. Do not invent a new design. If any text is uncertain, keep the label simple and clean rather than inventing wording.",
        spec ? `Verified packaging details of the real product (researched from its actual photos, follow them exactly):\n${spec}` : "",
        "Composition: one single product only, shown straight on from the front, perfectly upright and centred, the whole product fully inside the frame with about 10% empty margin on every side, portrait orientation.",
        "Background: pure seamless white (#FFFFFF), no gradient, no floor line, no reflection. Only a very soft natural contact shadow directly under the product.",
        "Quality: sharp focus, crisp edges, accurate true-to-life colours, soft even studio lighting, realistic materials, high detail.",
        "Strictly avoid: extra objects, props, people, hands, additional products, watermarks, borders, captions, price tags, overlay text, distortion.",
    ].filter(Boolean).join("\n");
}

/* ---------------------------------- 3. model call ---------------------------------- */
// refPngs = array of reference PNG buffers (may be empty). The first one is the most important.
async function callModel(prompt, refPngs) {
    const c = client();
    const base = { model: MODEL, prompt, size: GEN_SIZE, quality: QUALITY, n: 1 };
    let res;
    if (refPngs.length) {
        const files = await Promise.all(refPngs.map((b, i) => toFile(b, `reference-${i + 1}.png`, { type: "image/png" })));
        const image = files.length === 1 ? files[0] : files;
        try {
            res = await c.images.edit({ ...base, image, input_fidelity: FIDELITY });
        } catch (e) {
            // some model versions don't take input_fidelity: retry without it
            if (e?.status === 400 && /input_fidelity/i.test(String(e?.message || ""))) res = await c.images.edit({ ...base, image });
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

// data = cleaned draft data. refUrl = the owner's own photo to copy from (or null).
export async function generateProductImage({ data, refUrl }) {
    const owner = refUrl ? await loadReference(refUrl) : null;
    const research = await safeResearch(data, owner);

    // owner's own photo first (it is the most trustworthy), then the verified web photos
    const refs = [owner, ...(research?.images || [])].filter(Boolean);

    console.log(
        `[catalogProductImage] "${productTitle(data)}": ${refs.length} reference(s)` +
        (research?.sources?.length ? `, web sources: ${research.sources.join(" | ")}` : research ? ", spec only" : ", no web research"),
    );

    const raw = await callModel(buildPrompt(data, refs.length > 0, research?.spec || "", refs.length), refs);
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