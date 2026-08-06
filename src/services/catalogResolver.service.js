// backend/services/catalogResolver.service.js
//
// The single place that turns a search term (typed or identified from a
// photo) into either an existing catalog location or a newly-created one.
// Used by both the text AI-resolve endpoint and the image search endpoint
// so they share identical dedup, moderation, and image-generation behavior.
//
// Order of resolution:
//   1. Embedding cascade against what already exists — product first (most
//      specific), then subcategory, then category. A confident match at
//      any level returns immediately with NO OpenAI classification call
//      and nothing written to the DB.
//   2. Only if nothing matches confidently: one GPT-5.6-Luna call to
//      moderate + map the term (reusing the same category/subcategory/
//      product shortlists), then find-or-create down to whatever level it
//      resolves to, generating an image for each newly-created row.
//
// All inserts are conflict-safe: if a concurrent request already created
// the same row (same unique slug) between our lookup and our insert, we
// catch the unique-violation and just use the row that won, instead of
// erroring out.

import { supabase } from "../config/supabase.js";
import { classifyQuery } from "./openaiCatalog.service.js";
import { getShortlists } from "./catalogShortlist.service.js";
import { embedText, embedTexts } from "./embeddings.service.js";
import { generateCatalogImage } from "./catalogImageGen.service.js";
import { convertPngToAvif } from "./cloudinaryConvert.service.js";
import { uploadCatalogImage } from "./catalogImageStorage.service.js";
import { waitUntil } from "@vercel/functions";
import { generateSpecSchema } from "./specSchema.service.js";
import { fillBrandSpecValues } from "./brandSpecFill.service.js";
import { createResolveLogger } from "../utils/resolveLogger.js";
import { slugify } from "./slugify.js";

// Cosine similarity thresholds for the direct-match cascade. Tune these if
// you find it matching too loosely/strictly in practice.
const PRODUCT_MATCH_THRESHOLD = 0.80;
const SUBCATEGORY_MATCH_THRESHOLD = 0.8;
const CATEGORY_MATCH_THRESHOLD = 0.8;

const CATEGORY_DEDUPE_FLOOR = 0.72;
const SUBCATEGORY_DEDUPE_FLOOR = 0.72;
// Products' last line of defense even if the LLM misses a dedup — see
// openaiCatalog.service.js and catalogShortlist.service.js for the
// upstream fix that makes the LLM far less likely to miss it in the first
// place (the candidate list it sees is now guaranteed-complete for the
// top subcategory match, not just a global embedding top-10).
const PRODUCT_DEDUPE_FLOOR = 0.78;
const BRAND_MATCH_THRESHOLD = 0.80;

const BRAND_DEDUPE_FLOOR = 0.86; // higher than the automatic-match cascade threshold on
// purpose — brand items are usually differentiated ONLY by part number/spec,
// so this needs to be strict enough that "13070 FWT" and "165100 RWT" don't
// collapse just because they share every other word in the name.

// ---- name-comparison helpers ----
//
// FIX: the old check for "generic_name is just a restatement of the
// subcategory name" was a strict, case-folded string equality. That let
// "Passenger Car Engine Oil" through as a product under subcategory
// "Passenger Car Engine Oils" — the only difference is the trailing "s",
// which strict equality doesn't catch. Normalize away punctuation and
// simple singular/plural before comparing.
function normalizeCatalogName(str) {
    return (str || "")
        .trim()
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

// catalogResolver.service.js — add near isTrivialRestatement

// Strips pure grade/spec tokens (viscosity grades, numeric codes) so two
// names differing ONLY by a spec qualifier compare as the same core
// concept — "Diesel Engine Oil" vs "15W-40 Diesel Engine Oil", or
// "Multipurpose Grease" vs "Industrial Multipurpose Grease".
function coreTokens(name) {
    return new Set(
        normalizeCatalogName(name)
            .split(" ")
            .filter(Boolean)
            .filter((tok) => !/^\d+w?\d*$/i.test(tok.replace(/-/g, ""))) // drop "15w40", "90", "140", etc.
    );
}

// True if the SMALLER name's core words are entirely a subset of the
// LARGER name's core words — i.e. one name is just the other plus extra
// qualifier words ("Multipurpose Grease" ⊂ "Industrial Multipurpose
// Grease"), which means they're the same underlying product line, not
// two distinct ones. This is a deterministic backstop — it does NOT rely
// on the LLM's judgment, because the LLM was already told this exact rule
// in plain English and still created the duplicate anyway.
function isNameContainmentDuplicate(nameA, nameB) {
    const a = coreTokens(nameA);
    const b = coreTokens(nameB);
    if (a.size === 0 || b.size === 0) return false;
    const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
    for (const tok of smaller) if (!larger.has(tok)) return false;
    return true;
}

function isTrivialRestatement(a, b) {
    const na = normalizeCatalogName(a);
    const nb = normalizeCatalogName(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    // singular/plural only difference, e.g. "engine oil" vs "engine oils"
    return na.replace(/s$/, "") === nb.replace(/s$/, "");
}

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return -1;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return -1;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Checks if `term` exactly matches a previously-rejected row at any level.
// Rejected rows are kept in the DB specifically so terms don't get
// reclassified and recreated — but that only saves cost if we actually
// check for them BEFORE spending on embeddings or an LLM call, not after.
async function findRejectedExactMatch(term) {
    const trimmed = term.trim();
    if (!trimmed) return null;

    const [cat, sub, prod, brand] = await Promise.all([
        supabase.from("hs_categories").select("id, name").eq("review_status", "rejected").ilike("name", trimmed).maybeSingle(),
        supabase.from("hs_subcategories").select("id, name").eq("review_status", "rejected").ilike("name", trimmed).maybeSingle(),
        supabase.from("hs_products").select("id, name").eq("review_status", "rejected").ilike("name", trimmed).maybeSingle(),
        supabase.from("hs_product_brands").select("id, name, brand_name").eq("review_status", "rejected").or(`name.ilike.${trimmed},brand_name.ilike.${trimmed}`).maybeSingle(),
    ]);

    if (brand.data) return { level: "brand", name: brand.data.name };
    if (prod.data) return { level: "product", name: prod.data.name };
    if (sub.data) return { level: "subcategory", name: sub.data.name };
    if (cat.data) return { level: "category", name: cat.data.name };
    return null;
}

// ---- image prompt variety ----
//
// Previously every category/subcategory/product/brand image used the same
// fixed PHOTO_STYLE string plus a single backdrop pick, and the
// container/setting hint for an entire regex bucket (e.g. everything
// matching /oil|lubricant|grease/) was one static sentence. That's why
// "Engine Oil", "10W-40 Engine Oil", and "Passenger Car Engine Oil" all
// rendered as the same can on the same backdrop — the prompts were nearly
// word-for-word identical, and image models anchor heavily on the literal
// prompt text, not on the one product name that differs between them.
//
// This section adds independent, deterministic (same item name always
// gets the same result — not random) variety axes that combine
// multiplicatively: backdrop x camera angle x container shape x accent
// color. None of this touches the text-classification call or its output
// tokens — it only changes the prompt sent to the image model, so it costs
// nothing extra on the side you're trying to control.

function hashSeed(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
}
function pickFrom(list, seedKey) {
    return list[hashSeed(seedKey) % list.length];
}

const PHOTO_QUALITY_BASE =
    "professional catalog photography, no text, no watermark, no logos, no brand names, sharp focus, realistic materials and lighting.";

// const BACKDROP_VARIANTS = [
//     "shot on a cool-white studio backdrop with a soft diffused shadow beneath it",
//     "shot on a warm light-grey studio backdrop with soft top-down lighting",
//     "shot on a pale stone-toned studio backdrop with gentle side lighting and a subtle reflection",
//     "shot on a crisp white cyclorama backdrop with even, shadowless studio lighting",
//     "shot on a muted sage-toned studio backdrop with soft directional lighting",
//     "shot on a soft charcoal-grey backdrop with a gentle rim light along one edge",
//     "shot on a pale sand-toned backdrop with warm low-angle lighting",
//     "shot on a cool slate-blue backdrop with even diffused overhead lighting",
//     "shot on an off-white textured backdrop with soft window-style natural light",
// ];

const BACKDROP_VARIANTS = [
    "shot on a solid light-grey studio backdrop (hex #DBDBDB) with soft diffused shadow beneath it",
    "shot on a solid light-grey studio backdrop (hex #DADADC) with even, shadowless studio lighting",
    "shot on a solid light-grey studio backdrop (hex #DBDBDB) with soft top-down lighting and a subtle reflection",
    "shot on a solid light-grey studio backdrop (hex #DADADC) with a gentle rim light along one edge",
    "shot on a solid light-grey studio backdrop (hex #DBDBDB) with soft directional lighting",
];

const ANGLE_VARIANTS = [
    "photographed straight-on at eye level",
    "photographed from a slightly elevated three-quarter angle",
    "photographed from a low angle looking slightly upward",
    "photographed from directly above, top-down",
    "photographed from a tight three-quarter angle emphasizing depth",
];

const ACCENT_COLOR_VARIANTS = [
    "deep blue", "amber orange", "forest green", "charcoal grey",
    "burgundy red", "steel silver", "muted teal", "warm brass",
];

function parseEmbedding(raw) {
    if (!raw) return null;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw); // pgvector often serializes as "[0.1,0.2,...]" over REST
            return Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
    return null;
}

function composeStyle(seedKey) {
    return [
        pickFrom(BACKDROP_VARIANTS, "backdrop:" + seedKey),
        pickFrom(ANGLE_VARIANTS, "angle:" + seedKey),
        PHOTO_QUALITY_BASE,
    ].join(", ");
}

// Container shape now gets its own small pool per archetype instead of one
// fixed sentence, so items sharing an archetype (e.g. every kind of oil)
// still land on visibly different packaging.
const CONTAINER_ARCHETYPES = [
    {
        test: /oil|lubricant|grease|coolant|hydraulic fluid/i,
        shapes: [
            "a slim rectangular plastic jerry-can with a fold-out spout and ridged grip panels",
            "a cylindrical metal drum with a screw-cap lid and a rolled rim",
            "a wide-based plastic pail with a snap-on lid and a side carry handle",
            "a tall bottle-style plastic jug with an integrated pour spout and a twist cap",
        ],
    },
    {
        test: /filter/i,
        shapes: [
            "a standalone spin-on cartridge filter with its threaded end and housing clearly visible",
            "a panel-style filter element shown flat with its pleated media visible",
        ],
    },
    {
        test: /earbud|headphone|speaker|charger|cable|electronics/i,
        shapes: [
            "a sleek modern unit with a matte plastic and brushed-metal finish",
            "a compact unit with a glossy plastic shell and rounded edges",
        ],
    },
    {
        test: /watch/i,
        shapes: ["shown at a three-quarter angle with its strap visible and the screen softly lit showing a simple watch face"],
    },
    {
        test: /bearing|fastener|bolt|nut|screw|hardware|gear/i,
        shapes: ["a precision-machined metal component with a true-to-life material finish and geometry"],
    },
    {
        test: /apparel|garment|fabric|textile|clothing/i,
        shapes: ["neatly flat-laid, with visible fabric texture and natural folds"],
    },
];
function pickContainerShape(seedKey, name, categoryName, subcategoryName) {
    const haystack = `${name} ${categoryName || ""} ${subcategoryName || ""}`;
    const archetype = CONTAINER_ARCHETYPES.find((c) => c.test.test(haystack));
    return archetype
        ? pickFrom(archetype.shapes, "shape:" + seedKey)
        : "packaged or presented in a form realistic and typical for this exact product type";
}

const ARRANGEMENT_VARIANTS = [
    "arranged in a loose diagonal cluster",
    "arranged in a clean grid with even spacing",
    "arranged in a loose scattered layout with slight overlap",
];

function categoryImagePrompt(name) {
    const seedKey = "cat:" + name;
    const arrangement = pickFrom(ARRANGEMENT_VARIANTS, "arrangement:" + seedKey);
    return `A curated flat-lay of 4-6 distinct items representing the "${name}" product category for a B2B industrial marketplace, items varied in shape and size, ${arrangement}, product centered horizontally with generous negative space, composed for a wide letterbox crop so nothing important sits near the top or bottom edge, ${composeStyle(seedKey)}`;
}
function subcategoryImagePrompt(name, categoryName) {
    const seedKey = "sub:" + name;
    const arrangement = pickFrom(ARRANGEMENT_VARIANTS, "arrangement:" + seedKey);
    return `A curated flat-lay of 3-5 distinct items representing the "${name}" subcategory within "${categoryName}" for a B2B industrial marketplace, items varied in shape and size, ${arrangement}, product centered horizontally with generous negative space, composed for a wide letterbox crop so nothing important sits near the top or bottom edge, ${composeStyle(seedKey)}`;
}
function productImagePrompt(name, description, categoryName, subcategoryName) {
    const seedKey = "prod:" + name;
    const shape = pickContainerShape(seedKey, name, categoryName, subcategoryName);
    const accent = pickFrom(ACCENT_COLOR_VARIANTS, "accent:" + seedKey);
    return `Product photo of "${name}"${description ? ` — ${description}` : ""}, ${shape}, with a ${accent} accent on the cap, trim, or housing for visual distinction, product centered horizontally with generous negative space, composed for a wide letterbox crop so nothing important sits near the top or bottom edge, ${composeStyle(seedKey)}`;
}
function brandImagePrompt(brandItemName, brandName, attributes, categoryName, subcategoryName) {
    // No synthetic accent color here on purpose — the brandLine below
    // already asks for the real, accurate brand color scheme, and stacking
    // a synthetic accent-color instruction on top of that just gives the
    // image model conflicting signals and makes real brands look wrong.
    const seedKey = "brand:" + brandItemName;
    const specs = (attributes || []).map((a) => `${a.name}: ${a.value}`).join(", ");
    const shape = pickContainerShape(seedKey, brandItemName, categoryName, subcategoryName);
    const brandLine = brandName
        ? ` Show it as an authentic ${brandName} retail product — accurate real-world packaging shape, proportions, and typical color scheme for this brand and product line, as closely as possible to how it actually looks on shelf.`
        : "";
    return `Product photo of ${brandItemName}${specs ? ` — ${specs}` : ""}, ${shape}.${brandLine} Product centered horizontally with generous negative space, composed for a wide letterbox crop so nothing important sits near the top or bottom edge, ${composeStyle(seedKey)}`;
}

// A 429 from the image model shouldn't just be logged and abandoned —
// it tells you exactly how long to wait ("try again in 12s"), so parse
// that and retry a couple of times before giving up for real.
async function generateAndAttachImage(table, id, prompt, attempt = 1) {
    try {
        const pngBase64 = await generateCatalogImage(prompt);
        const avifBuffer = await convertPngToAvif(pngBase64, `${table}-${id}`);
        const publicUrl = await uploadCatalogImage(avifBuffer, `${table}/${id}.avif`);
        await supabase.from(table).update({ image: publicUrl }).eq("id", id);
        return publicUrl;
    } catch (err) {
        const is429 = err.message?.includes("429") || err.status === 429;
        if (is429 && attempt < 4) {
            const waitMatch = err.message?.match(/try again in (\d+(?:\.\d+)?)s/i);
            const waitMs = waitMatch ? Math.ceil(parseFloat(waitMatch[1]) * 1000) + 500 : attempt * 5000;
            console.warn(`image gen rate-limited for ${table}/${id}, retrying in ${waitMs}ms (attempt ${attempt + 1}/4)`);
            await new Promise((r) => setTimeout(r, waitMs));
            return generateAndAttachImage(table, id, prompt, attempt + 1);
        }
        console.error(`AI image pipeline failed for ${table}/${id}:`, err.message);
        return null;
    }
}

// Inserts a row; if a concurrent request already created the same unique
// key, fetches and returns that row instead of throwing.
async function insertOrFetchOnConflict(table, insertPayload, conflictFilter, selectCols) {
    const { data, error } = await supabase.from(table).insert(insertPayload).select(selectCols).single();
    if (!error) return { ...data, isNew: true };

    if (error.code !== "23505") throw error;

    let q = supabase.from(table).select(selectCols);
    for (const [key, value] of Object.entries(conflictFilter)) q = q.eq(key, value);
    const { data: existing, error: fetchErr } = await q.single();
    if (fetchErr) throw fetchErr;
    return { ...existing, isNew: false };
}

// ---- find-or-create ----

async function createCategory(name, embedding) {
    const slug = slugify(name);
    return insertOrFetchOnConflict(
        "hs_categories",
        { name, slug, is_ai_generated: true, embedding, review_status: "pending_review" },
        { slug },
        "id, name, image"
    );
}

async function createSubcategory(categoryId, name, embedding) {
    const slug = slugify(name);
    return insertOrFetchOnConflict(
        "hs_subcategories",
        { category_id: categoryId, name, slug, is_ai_generated: true, embedding, review_status: "pending_review" },
        { category_id: categoryId, slug },
        "id, name, image"
    );
}

async function resolveCategory(classification, shortlists, embeddingByKey, log) {
    if (classification.match_category_id) {
        const { data } = await supabase
            .from("hs_categories")
            .select("id, name, image")
            .eq("id", classification.match_category_id)
            .maybeSingle();
        if (data) {
            log.info("category: matched via LLM match_category_id", data.id, data.name);
            return { ...data, isNew: false };
        }
    }
    if (!classification.new_category_name) return null;

    // 1. Exact-name safety net (catches case/whitespace-only "duplicates")
    const { data: existingByName } = await supabase
        .from("hs_categories")
        .select("id, name, image")
        .ilike("name", classification.new_category_name)
        .maybeSingle();
    if (existingByName) {
        log.warn("category: exact-name safety net caught a would-be duplicate ->", existingByName.name);
        return { ...existingByName, isNew: false };
    }

    // 2. Embedding-based safety net — don't fully trust the LLM's "this
    // needs a new category" call.
    const top = shortlists.categories[0];
    if (top && top.similarity >= CATEGORY_DEDUPE_FLOOR) {
        log.warn(
            `category: overriding LLM's "new_category_name=${classification.new_category_name}" — ` +
            `reusing shortlisted "${top.name}" (similarity ${top.similarity.toFixed(3)} >= ${CATEGORY_DEDUPE_FLOOR})`
        );
        return { id: top.id, name: top.name, image: top.image, isNew: false };
    }

    log.info("category: creating new ->", classification.new_category_name);
    return createCategory(classification.new_category_name, embeddingByKey.category);
}

async function resolveSubcategory(classification, categoryId, shortlists, embeddingByKey, log) {
    if (classification.match_subcategory_id) {
        const { data } = await supabase
            .from("hs_subcategories")
            .select("id, name, image, category_id")
            .eq("id", classification.match_subcategory_id)
            .maybeSingle();
        if (data && data.category_id === categoryId) {
            log.info("subcategory: matched via LLM match_subcategory_id", data.id, data.name);
            return { ...data, isNew: false };
        }
    }
    if (!classification.new_subcategory_name) return null;

    const { data: existing } = await supabase
        .from("hs_subcategories")
        .select("id, name, image")
        .eq("category_id", categoryId)
        .ilike("name", classification.new_subcategory_name)
        .maybeSingle();
    if (existing) {
        log.warn("subcategory: exact-name safety net caught a would-be duplicate ->", existing.name);
        return { ...existing, isNew: false };
    }

    // Embedding-based floor, scoped to this category only
    const top = shortlists.subcategories.find((s) => s.category_id === categoryId);
    if (top && top.similarity >= SUBCATEGORY_DEDUPE_FLOOR) {
        log.warn(
            `subcategory: overriding LLM's "new_subcategory_name=${classification.new_subcategory_name}" — ` +
            `reusing shortlisted "${top.name}" (similarity ${top.similarity.toFixed(3)} >= ${SUBCATEGORY_DEDUPE_FLOOR})`
        );
        return { id: top.id, name: top.name, image: top.image, isNew: false };
    }

    log.info("subcategory: creating new ->", classification.new_subcategory_name);
    return createSubcategory(categoryId, classification.new_subcategory_name, embeddingByKey.subcategory);
}
async function resolveProduct(classification, subcategoryId, shortlists, embeddingByKey, log, categoryName, subcategoryName) {
    // 0. LLM explicitly said this is the same generic product line as an
    // existing candidate — the fix for "Engine Oil" / "10W-40 Engine Oil"
    // / "Passenger Car Engine Oil" all existing as separate products.
    if (classification.match_product_id) {
        const { data } = await supabase
            .from("hs_products")
            .select("id, name, image, subcategory_id")
            .eq("id", classification.match_product_id)
            .maybeSingle();
        if (data && data.subcategory_id === subcategoryId) {
            log.info("product: matched via LLM match_product_id", data.id, data.name);
            return { ...data, isNew: false };
        }
    }

    const name = classification.generic_name;
    if (!name || !subcategoryId) return null;

    const { data: existing } = await supabase
        .from("hs_products")
        .select("id, name, image")
        .eq("subcategory_id", subcategoryId)
        .ilike("name", name)
        .maybeSingle();
    if (existing) {
        log.info("product: exact-name match found ->", existing.name);
        return { ...existing, isNew: false };
    }

    // Embedding-based safety net, scoped to this subcategory.
    // Hard containment check across EVERY sibling already in this
    // subcategory (shortlists.products is guaranteed-complete for the
    // top-matching subcategory, per catalogShortlist's completeness
    // supplement) — not just the single top-embedding match. This catches
    // exactly the cases the LLM was instructed to avoid but didn't:
    // "Diesel Engine Oil" / "15W-40 Diesel Engine Oil",
    // "Multipurpose Grease" / "Industrial Multipurpose Grease".
    const top = shortlists.products.find((p) => p.subcategory_id === subcategoryId && p.similarity >= PRODUCT_DEDUPE_FLOOR);

    const containmentMatch = shortlists.products.find(
        (p) => p.subcategory_id === subcategoryId && p.id !== top?.id && isNameContainmentDuplicate(name, p.name)
    );
    if (containmentMatch) {
        log.warn(
            `product: BLOCKED creating "${name}" — core name is contained in / contains existing ` +
            `"${containmentMatch.name}", reusing that instead (this overrides the LLM's own decision)`
        );
        return { id: containmentMatch.id, name: containmentMatch.name, image: containmentMatch.image, isNew: false };
    }


    if (top) {
        log.warn(
            `product: overriding LLM's "generic_name=${name}" — ` +
            `reusing shortlisted "${top.name}" (similarity ${top.similarity.toFixed(3)} >= ${PRODUCT_DEDUPE_FLOOR})`
        );
        return { id: top.id, name: top.name, image: top.image, isNew: false };
    }

    // Governance/visibility: the shortlist now guarantees every existing
    // product in this subcategory is present (see catalogShortlist.service
    // .js), so if we're about to mint a new one anyway while siblings
    // exist, that's worth a loud log line for a human to spot-check —
    // rather than silently letting a duplicate pile up unnoticed until
    // someone stumbles onto it in the catalog months later.
    const siblingsInSubcategory = shortlists.products.filter((p) => p.subcategory_id === subcategoryId);
    if (siblingsInSubcategory.length) {
        log.warn(
            `product: creating "${name}" as NEW despite ${siblingsInSubcategory.length} existing sibling(s) in this subcategory ` +
            `(${siblingsInSubcategory.map((s) => s.name).join(", ")}) — flag for catalog review if this looks like a duplicate`
        );
    }

    const slug = slugify(name);
    const embedding = embeddingByKey.product;
    log.info("product: creating new ->", name);

    // only reached when actually creating a new product row
    const specSchema = await generateSpecSchema({
        genericName: name,
        categoryName,
        subcategoryName,
        description: classification.description,
    });


    return insertOrFetchOnConflict(
        "hs_products",
        {
            subcategory_id: subcategoryId, name, slug,
            description: classification.description || null,
            generic_name: name,
            variants: classification.variants || [],
            attributes: Object.fromEntries((classification.attributes || []).map((a) => [a.name, a.value])),
            spec_schema: specSchema,
            is_ai_generated: true, embedding, review_status: "pending_review",
        },
        { subcategory_id: subcategoryId, slug },
        "id, name, image, spec_schema"
    );
}

// ---- step 1: direct embedding-cascade match against what already exists ----

function findDirectMatch(shortlists) {
    const topBrand = shortlists.brands?.[0];
    if (topBrand && topBrand.similarity >= BRAND_MATCH_THRESHOLD) {
        return {
            stack: [
                { level: "category", id: topBrand.category_id, name: topBrand.category_name },
                { level: "subcategory", id: topBrand.subcategory_id, name: topBrand.subcategory_name },
                { level: "product", id: topBrand.product_id, name: topBrand.product_name },
                { level: "brand", id: topBrand.id, name: topBrand.name },
            ],
        };
    }

    const topProduct = shortlists.products[0];
    if (topProduct && topProduct.similarity >= PRODUCT_MATCH_THRESHOLD) {
        return {
            stack: [
                { level: "category", id: topProduct.category_id, name: topProduct.category_name },
                { level: "subcategory", id: topProduct.subcategory_id, name: topProduct.subcategory_name },
                { level: "product", id: topProduct.id, name: topProduct.name },
            ],
        };
    }

    const topSubcategory = shortlists.subcategories[0];
    if (topSubcategory && topSubcategory.similarity >= SUBCATEGORY_MATCH_THRESHOLD) {
        return {
            stack: [
                { level: "category", id: topSubcategory.category_id, name: topSubcategory.category_name },
                { level: "subcategory", id: topSubcategory.id, name: topSubcategory.name },
            ],
        };
    }

    const topCategory = shortlists.categories[0];
    if (topCategory && topCategory.similarity >= CATEGORY_MATCH_THRESHOLD) {
        return { stack: [{ level: "category", id: topCategory.id, name: topCategory.name }] };
    }

    return null;
}

// catalogResolver.service.js

// Extracts identifying codes/part-numbers from a name — things like
// "13070", "BTH 0065", "566425.H195", "VKBA 5423". These are the ACTUAL
// disambiguating tokens in auto-parts catalogs; two SKUs can share every
// other word ("Unitized", "Wheel Bearing", "Front/Rear Axle") and still
// be completely different parts, which is exactly why embedding
// similarity alone can score 0.90+ on two distinct SKUs (see: "13070 FWT"
// vs "165100 RWT" scored 0.904; "VKBA 5423" vs "VKBA 5425" scored 0.985).
// Matches: alphanumeric codes with at least one digit, optionally
// prefixed with letters, allowing internal . - / (e.g. "566425.H195").
// Pulls every numeric token out of a name — grades ("90", "140"), part
// numbers ("13070"), spec codes ("VKBA5423"), whatever. No minimum digit
// count: a 2-digit viscosity grade ("90" vs "140") is just as much a real
// distinguishing feature as a 6-digit part number, and the earlier 3+
// digit threshold is exactly why "Spirax S2 G 90" wrongly merged with
// "Spirax S2 G 140" — "90" never qualified as a code, so the conflict
// check saw nothing to compare and fell through to raw text similarity,
// which is fooled by the two names sharing every other word.
function extractCodes(name) {
    if (!name) return new Set();
    const matches = name.match(/\d[\dA-Za-z.\-/]*\d|\d+/g) || [];
    return new Set(matches.map((c) => c.toUpperCase().replace(/[.\-/\s]/g, "")));
}


// Compares the PRIMARY (longest) code on each side rather than any-overlap
// — this is what correctly separates "VKBA5423" from "VKBA5425" and
// "566425H195" from "566426H195" despite their shared prefixes/suffixes.
// Conservative by design: require the full set of numeric tokens to
// match EXACTLY before allowing embedding similarity to decide anything.
// Any difference in the numbers present — a different grade, a different
// part number, an extra/missing spec — is treated as a real SKU
// difference, not something similarity should be allowed to paper over.
// This errs toward creating an extra row over wrongly merging two
// distinct SKUs, which is the safer failure mode for a live catalog.
function codesConflict(codesA, codesB) {
    if (codesA.size === 0 || codesB.size === 0) return false; // neither side has a number to compare — let embedding decide
    if (codesA.size !== codesB.size) return true;
    for (const c of codesA) if (!codesB.has(c)) return true;
    return false;
}

async function resolveBrandItem(classification, productId, shortlists, embeddingByKey, log, brandSpecFill) {
    if (!classification.is_branded || !classification.brand_item_name || !productId) return null;

    const { data: existing } = await supabase
        .from("hs_product_brands")
        .select("id, name, image")
        .eq("product_id", productId)
        .ilike("name", classification.brand_item_name)
        .maybeSingle();
    if (existing) return { ...existing, isNew: false };

    const incomingCodes = extractCodes(classification.brand_item_name);

    const { data: siblingBrands } = await supabase
        .from("hs_product_brands")
        .select("id, name, image, embedding")
        .eq("product_id", productId);

    if (siblingBrands?.length && embeddingByKey.brand) {
        let best = null;
        for (const sib of siblingBrands) {
            // Hard veto: if this sibling has a different identifying code
            // than the incoming item, it is NOT the same SKU — full stop,
            // regardless of how high the embedding similarity comes back.
            // This is what actually fixes the "13070 FWT" / "165100 RWT"
            // and "VKBA 5423" / "VKBA 5425" false merges: those pairs have
            // conflicting codes, so they're excluded from consideration
            // before similarity is even weighed.
            const sibCodes = extractCodes(sib.name);
            if (codesConflict(incomingCodes, sibCodes)) continue;

            const sibEmbedding = parseEmbedding(sib.embedding);
            if (!sibEmbedding) continue;
            const sim = cosineSimilarity(embeddingByKey.brand, sibEmbedding);
            if (!best || sim > best.sim) best = { ...sib, sim };
        }
        if (best && best.sim >= BRAND_DEDUPE_FLOOR) {
            log.warn(`brand: reusing "${best.name}" for incoming "${classification.brand_item_name}" (similarity ${best.sim.toFixed(3)} >= ${BRAND_DEDUPE_FLOOR}, no code conflict)`);
            return { id: best.id, name: best.name, image: best.image, isNew: false };
        }
        if (best) {
            log.info(`brand: creating new — closest non-conflicting sibling "${best.name}" only scored ${best.sim.toFixed(3)}, below floor ${BRAND_DEDUPE_FLOOR}`);
        } else if (siblingBrands.length) {
            log.info(`brand: creating new — all ${siblingBrands.length} sibling(s) had conflicting codes, no comparison possible`);
        }
    }

    const slug = slugify(classification.brand_item_name);
    return insertOrFetchOnConflict(
        "hs_product_brands",
        {
            product_id: productId,
            brand_name: classification.brand_name,
            seller_company_name: classification.seller_company_name || null,
            name: classification.brand_item_name,
            slug,
            description: classification.description || null,
            attributes: brandSpecFill.values.length
                ? Object.fromEntries(brandSpecFill.values.map((a) => [a.key, a.value]))
                : Object.fromEntries((classification.brand_attributes || []).map((a) => [a.name, a.value])),
            spec_grounded: brandSpecFill.grounded && brandSpecFill.values.length > 0,
            is_ai_generated: true,
            embedding: embeddingByKey.brand,
            review_status: "pending_review",
        },
        { product_id: productId, slug },
        "id, name, image"
    );
}

// ---- entrypoint ----

// { term, level, parentId } -> { success, resolved, aiGenerated, stack?, noSellersYet?, reason? }
export async function resolveOrCreateCatalogEntry({ term, level, parentId }) {
    const log = createResolveLogger(term);
    log.info("start", { level, parentId });

    // Check for a previously-rejected exact match FIRST, before spending
    // anything on embeddings or the LLM — this is the entire point of
    // keeping rejected rows around instead of deleting them.
    const rejectedMatch = await findRejectedExactMatch(term);
    if (rejectedMatch) {
        log.warn("term was already reviewed and rejected, skipping AI entirely ->", rejectedMatch);
        return {
            success: true,
            resolved: false,
            aiGenerated: false,
            rejected: true,
            reason: "This item was already reviewed and isn't available for listing on BBM Marketplace.",
        };
    }

    const shortlists = await getShortlists(term);

    log.info("shortlists", {
        categories: shortlists.categories.map((c) => `${c.name}(${c.similarity.toFixed(3)})`),
        subcategories: shortlists.subcategories.map((s) => `${s.name}(${s.similarity.toFixed(3)})`),
        products: shortlists.products.map((p) => `${p.name}(${p.similarity.toFixed(3)})`),
    });

    const directMatch = findDirectMatch(shortlists);
    if (directMatch) {
        log.info("direct match found, skipping LLM classification entirely", directMatch.stack);
        return { success: true, resolved: true, aiGenerated: false, stack: directMatch.stack, noSellersYet: false };
    }

    const classification = await classifyQuery(term, {
        level,
        categoryShortlist: shortlists.categories,
        subcategoryShortlist: shortlists.subcategories,
        productShortlist: shortlists.products,
    });
    log.info("classification result", classification);

    if (!classification.valid) {
        log.warn("rejected by moderation:", classification.rejection_reason);
        return { success: true, resolved: false, reason: classification.rejection_reason || "This item can't be listed on BBM Marketplace. Please try a different search." };
    }

    const namesToEmbed = [];
    if (classification.new_category_name) namesToEmbed.push({ key: "category", text: classification.new_category_name });
    if (classification.new_subcategory_name) namesToEmbed.push({ key: "subcategory", text: classification.new_subcategory_name });
    if (classification.generic_name) namesToEmbed.push({ key: "product", text: classification.generic_name });
    if (classification.is_branded && classification.brand_item_name) {
        namesToEmbed.push({ key: "brand", text: classification.brand_item_name });
    }

    const embeddedValues = namesToEmbed.length ? await embedTexts(namesToEmbed.map((n) => n.text)) : [];
    const embeddingByKey = Object.fromEntries(namesToEmbed.map((n, i) => [n.key, embeddedValues[i]]));

    const categoryRow = await resolveCategory(classification, shortlists, embeddingByKey, log);
    if (!categoryRow) {
        log.warn("could not resolve a category at all");
        return { success: true, resolved: false, reason: "We couldn't confidently categorize this item. Please try a more specific search term." };
    }

    const subcategoryRow = await resolveSubcategory(classification, categoryRow.id, shortlists, embeddingByKey, log);

    // FIX: was a strict string-equality check, which let "Passenger Car
    // Engine Oil" (product) slip through under "Passenger Car Engine Oils"
    // (subcategory) — the only difference was the trailing "s". Normalized
    // comparison catches simple plural/punctuation variants too.
    const genericNameDuplicatesSubcategory =
        subcategoryRow && classification.generic_name &&
        isTrivialRestatement(classification.generic_name, subcategoryRow.name);
    if (genericNameDuplicatesSubcategory) {
        log.warn(`product: skipping — generic_name "${classification.generic_name}" duplicates subcategory name "${subcategoryRow.name}", would create redundant level`);
    }
    const productRow = subcategoryRow && !genericNameDuplicatesSubcategory
        ? await resolveProduct(classification, subcategoryRow.id, shortlists, embeddingByKey, log, categoryRow.name, subcategoryRow.name)
        : null;

    if (productRow && !productRow.spec_schema?.length) {
        const schema = await generateSpecSchema({
            genericName: productRow.name,
            categoryName: categoryRow.name,
            subcategoryName: subcategoryRow?.name,
            description: classification.description,
        });
        if (schema.length) {
            await supabase.from("hs_products").update({ spec_schema: schema }).eq("id", productRow.id);
            productRow.spec_schema = schema;
        }
    }

    let brandSpecFill = { values: [], grounded: false };
    if (classification.is_branded && productRow?.spec_schema?.length) {
        brandSpecFill = await fillBrandSpecValues({
            brandItemName: classification.brand_item_name,
            brandName: classification.brand_name,
            specSchema: productRow.spec_schema,
            useWebSearch: true, // named brand+model — worth grounding
        });
    }

    const brandRow = productRow
        ? await resolveBrandItem(classification, productRow.id, shortlists, embeddingByKey, log, brandSpecFill)
        : null;

    const stack = [
        { level: "category", id: categoryRow.id, name: categoryRow.name },
        subcategoryRow && { level: "subcategory", id: subcategoryRow.id, name: subcategoryRow.name },
        productRow && { level: "product", id: productRow.id, name: productRow.name },
        brandRow && { level: "brand", id: brandRow.id, name: brandRow.name },
    ].filter(Boolean);

    const pendingImages = [];
    if (brandRow?.isNew) pendingImages.push({ level: "brand", id: brandRow.id, table: "hs_product_brands" });
    if (productRow?.isNew) pendingImages.push({ level: "product", id: productRow.id, table: "hs_products" });
    if (subcategoryRow?.isNew) pendingImages.push({ level: "subcategory", id: subcategoryRow.id, table: "hs_subcategories" });
    if (categoryRow.isNew) pendingImages.push({ level: "category", id: categoryRow.id, table: "hs_categories" });

    waitUntil(
        Promise.all(
            pendingImages.map(async (p) => {
                const prompt =
                    p.level === "brand" ? brandImagePrompt(brandRow.name, classification.brand_name, classification.brand_attributes, categoryRow.name, subcategoryRow?.name) :
                        p.level === "product" ? productImagePrompt(productRow.name, classification.description, categoryRow.name, subcategoryRow?.name) :
                            p.level === "subcategory" ? subcategoryImagePrompt(subcategoryRow.name, categoryRow.name) :
                                categoryImagePrompt(categoryRow.name);
                log.info(`background image gen starting for ${p.level} ${p.id}`);
                const url = await generateAndAttachImage(p.table, p.id, prompt);
                log.info(`background image gen ${url ? "done" : "failed"} for ${p.level} ${p.id}`);
                return url;
            })
        )
    );

    return {
        success: true,
        resolved: true,
        aiGenerated: true,
        stack, // image fields simply null on new rows for now
        noSellersYet: !!(brandRow || productRow),
        pendingImages: pendingImages.map(({ level, id }) => ({ level, id })),
    };

}

export { resolveCategory, resolveSubcategory, resolveProduct, resolveBrandItem, categoryImagePrompt, subcategoryImagePrompt, productImagePrompt, brandImagePrompt, generateAndAttachImage };