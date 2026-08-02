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

async function generateAndAttachImage(table, id, prompt) {
    try {
        const pngBase64 = await generateCatalogImage(prompt);
        const avifBuffer = await convertPngToAvif(pngBase64, `${table}-${id}`);
        const publicUrl = await uploadCatalogImage(avifBuffer, `${table}/${id}.avif`);
        await supabase.from(table).update({ image: publicUrl }).eq("id", id);
        return publicUrl;
    } catch (err) {
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

async function resolveProduct(classification, subcategoryId, shortlists, embeddingByKey, log) {
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
    const top = shortlists.products.find((p) => p.subcategory_id === subcategoryId && p.similarity >= PRODUCT_DEDUPE_FLOOR);
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
    return insertOrFetchOnConflict(
        "hs_products",
        {
            subcategory_id: subcategoryId,
            name,
            slug,
            description: classification.description || null,
            generic_name: name,
            variants: classification.variants || [],
            attributes: Object.fromEntries((classification.attributes || []).map((a) => [a.name, a.value])),
            is_ai_generated: true,
            embedding,
            review_status: "pending_review",
        },
        { subcategory_id: subcategoryId, slug },
        "id, name, image"
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

async function resolveBrandItem(classification, productId, shortlists, embeddingByKey, log) {
    if (!classification.is_branded || !classification.brand_item_name || !productId) return null;

    const { data: existing } = await supabase
        .from("hs_product_brands")
        .select("id, name, image")
        .eq("product_id", productId)
        .ilike("name", classification.brand_item_name)
        .maybeSingle();
    if (existing) return { ...existing, isNew: false };

    // FIX: the old check was `shortlists.brands.find(b => b.product_id ===
    // productId)` — the FIRST brand under this product, regardless of
    // whether its name has anything to do with the item being resolved
    // right now. Combined with session-tracked brands being injected with
    // similarity: 1 (see runImportJob.service.js), this made EVERY brand
    // under a shared product collapse onto whichever brand was created
    // first — e.g. 7 distinct part numbers (13070 FWT, 165100 RWT, 142523
    // DR, ...) all reusing one brand row. Fix: pull the REAL existing
    // brand rows (with embeddings) under this product from the DB, and
    // compute genuine cosine similarity between THIS item's own
    // brand_item_name embedding and each sibling's — never trust a
    // pre-fetched, possibly page-shared or session-injected score.
    const { data: siblingBrands } = await supabase
        .from("hs_product_brands")
        .select("id, name, image, embedding")
        .eq("product_id", productId);

    if (siblingBrands?.length && embeddingByKey.brand) {
        let best = null;
        for (const sib of siblingBrands) {
            const sibEmbedding = parseEmbedding(sib.embedding);
            if (!sibEmbedding) continue;
            const sim = cosineSimilarity(embeddingByKey.brand, sibEmbedding);
            if (!best || sim > best.sim) best = { ...sib, sim };
        }
        if (best && best.sim >= BRAND_DEDUPE_FLOOR) {
            log.warn(`brand: reusing "${best.name}" for incoming "${classification.brand_item_name}" (similarity ${best.sim.toFixed(3)} >= ${BRAND_DEDUPE_FLOOR})`);
            return { id: best.id, name: best.name, image: best.image, isNew: false };
        }
        if (best) {
            log.info(
                `brand: creating new — closest sibling "${best.name}" only scored ${best.sim.toFixed(3)}, ` +
                `below floor ${BRAND_DEDUPE_FLOOR}`
            );
        }
    }

    const slug = slugify(classification.brand_item_name);
    return insertOrFetchOnConflict(
        "hs_product_brands",
        {
            product_id: productId,
            brand_name: classification.brand_name,
            name: classification.brand_item_name,
            slug,
            description: classification.description || null,
            seller_company_name: classification.seller_company_name || null,
            attributes: Object.fromEntries((classification.brand_attributes || []).map((a) => [a.name, a.value])),
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
        ? await resolveProduct(classification, subcategoryRow.id, shortlists, embeddingByKey, log)
        : null;

    const brandRow = productRow ? await resolveBrandItem(classification, productRow.id, shortlists, embeddingByKey, log) : null;

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