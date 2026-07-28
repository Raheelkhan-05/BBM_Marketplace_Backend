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
//      moderate + map the term (reusing the same category/subcategory
//      shortlists), then find-or-create down to whatever level it
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
import { createResolveLogger } from "../utils/resolveLogger.js";
import { slugify } from "./slugify.js";

// Cosine similarity thresholds for the direct-match cascade. Tune these if
// you find it matching too loosely/strictly in practice.
const PRODUCT_MATCH_THRESHOLD = 0.82;
const SUBCATEGORY_MATCH_THRESHOLD = 0.8;
const CATEGORY_MATCH_THRESHOLD = 0.8;

const CATEGORY_DEDUPE_FLOOR = 0.72;
const SUBCATEGORY_DEDUPE_FLOOR = 0.72;
const BRAND_MATCH_THRESHOLD = 0.80;


const PHOTO_STYLE = "plain neutral studio background, no text, no watermark, no logos, no brand names, professional catalog photography, product centered horizontally with generous negative space on both sides, composed for a wide letterbox crop so nothing important sits near the top or bottom edge.";

function categoryImagePrompt(name) {
    return `Flat-lay of assorted everyday items representing the "${name}" product category for a B2B industrial marketplace, ${PHOTO_STYLE}`;
}
function subcategoryImagePrompt(name, categoryName) {
    return `Flat-lay of assorted items representing the "${name}" subcategory within "${categoryName}" for a B2B industrial marketplace, ${PHOTO_STYLE}`;
}
function productImagePrompt(name, description) {
    return `Product photo of ${name}${description ? ` — ${description}` : ""}, centered, ${PHOTO_STYLE}`;
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
        { name, slug, is_ai_generated: true, embedding },
        { slug },
        "id, name, image"
    );
}

async function createSubcategory(categoryId, name, embedding) {
    const slug = slugify(name);
    return insertOrFetchOnConflict(
        "hs_subcategories",
        { category_id: categoryId, name, slug, is_ai_generated: true, embedding },
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

async function resolveProduct(classification, subcategoryId, embeddingByKey, log) {
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

function brandImagePrompt(brandItemName, brandName, attributes) {
    const specs = (attributes || []).map((a) => `${a.name}: ${a.value}`).join(", ");
    const brandLine = brandName
        ? ` Show it as an authentic ${brandName} retail product — accurate real-world packaging shape, proportions, and typical color scheme for this brand and product line, as closely as possible to how it actually looks on shelf.`
        : "";
    return `Product photo of ${brandItemName}${specs ? ` — ${specs}` : ""}, centered.${brandLine} ${PHOTO_STYLE}`;
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

    // reuse the global brand shortlist already fetched, scoped to this product
    const top = shortlists.brands.find((b) => b.product_id === productId);
    if (top && top.similarity >= 0.72) {
        log.warn(`brand: reusing shortlisted "${top.name}" instead of creating duplicate`);
        return { id: top.id, name: top.name, image: top.image, isNew: false };
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
            attributes: Object.fromEntries((classification.brand_attributes || []).map((a) => [a.name, a.value])),
            is_ai_generated: true,
            embedding: embeddingByKey.brand,
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
    // const categoryRow = await resolveCategory(classification, shortlists, log);
    if (!categoryRow) {
        log.warn("could not resolve a category at all");
        return { success: true, resolved: false, reason: "We couldn't confidently categorize this item. Please try a more specific search term." };
    }

    // if (categoryRow.isNew) {
    //     const url = await generateAndAttachImage("hs_categories", categoryRow.id, categoryImagePrompt(categoryRow.name));
    //     if (url) categoryRow.image = url;
    // }

    const subcategoryRow = await resolveSubcategory(classification, categoryRow.id, shortlists, embeddingByKey, log);
    // if (subcategoryRow?.isNew) {
    //     const url = await generateAndAttachImage(
    //         "hs_subcategories",
    //         subcategoryRow.id,
    //         subcategoryImagePrompt(subcategoryRow.name, categoryRow.name)
    //     );
    //     if (url) subcategoryRow.image = url;
    // }

    const productRow = subcategoryRow ? await resolveProduct(classification, subcategoryRow.id, embeddingByKey, log) : null;

    const brandRow = productRow ? await resolveBrandItem(classification, productRow.id, shortlists, embeddingByKey, log) : null;
    // if (productRow?.isNew) {
    //     const url = await generateAndAttachImage(
    //         "hs_products",
    //         productRow.id,
    //         productImagePrompt(productRow.name, classification.description)
    //     );
    //     if (url) productRow.image = url;
    // }

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

    (async () => {
        for (const p of pendingImages) {
            const prompt =
                p.level === "brand" ? brandImagePrompt(brandRow.name, classification.brand_name, classification.brand_attributes) :
                    p.level === "product" ? productImagePrompt(productRow.name, classification.description) :
                        p.level === "subcategory" ? subcategoryImagePrompt(subcategoryRow.name, categoryRow.name) :
                            categoryImagePrompt(categoryRow.name);
            log.info(`background image gen starting for ${p.level} ${p.id}`);
            const url = await generateAndAttachImage(p.table, p.id, prompt);
            log.info(`background image gen ${url ? "done" : "failed"} for ${p.level} ${p.id}`);
        }
    })();

    return {
        success: true,
        resolved: true,
        aiGenerated: true,
        stack, // image fields simply null on new rows for now
        noSellersYet: !!(brandRow || productRow),
        pendingImages: pendingImages.map(({ level, id }) => ({ level, id })),
    };

}