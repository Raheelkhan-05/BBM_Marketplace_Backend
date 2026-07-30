// backend/services/openaiCatalog.service.js
//
// Wraps GPT-5.6-Luna to do three things in one cheap call:
//   1. Moderation — refuse anything that isn't a legitimate, legally
//      tradable B2B/industrial good.
//   2. Mapping — reuse an existing category/subcategory/product when one
//      of the shortlisted candidates is clearly the same thing, instead of
//      creating near-duplicates like "Stationery" vs "Office Supplies", or
//      "Engine Oil" vs "10W-40 Engine Oil" vs "Passenger Car Engine Oil".
//   3. Enrichment — generic name, short description, variants, attributes.
//
// CANDIDATE PRODUCTS note: as of catalogShortlist.service.js's completeness
// supplement, this list is no longer just a global embedding top-10 — it's
// guaranteed to include every existing product already filed under the
// most likely subcategory match. That was the actual root cause of the
// "Engine Oil" / "10W-40 Engine Oil" / "Passenger Car Engine Oil" split:
// the true sibling often wasn't even in the candidate list the model saw.
// The mapping rules below are unchanged, but the model now has a real shot
// at following them.
//
// No web_search tool here on purpose: everyday product classification
// doesn't need it, and it was the single biggest token cost in earlier
// versions of this service. Reasoning effort is kept at "low" — enough for
// reliable moderation + mapping on short inputs like this without paying
// for more. (If you find match_product_id is still being missed on cases
// where the correct sibling is clearly present in the candidate list, that
// —not threshold-tuning— is the signal to try bumping this to "medium";
// it does cost more in reasoning/output tokens, so worth confirming the
// candidate-list fix alone isn't enough first.)

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `
You are BBM Marketplace's catalog classifier (Brand Brigade Marketing Pvt
Ltd), a B2B industrial/commercial trading platform in India.

Reject (valid=false, short buyer-facing rejection_reason) if the term is or
implies: a weapon/ammunition/explosive; a narcotic or controlled substance;
an endangered-species or wildlife-trade-restricted product; human remains;
a counterfeit or stolen good; a prescription drug or licensed medical
device; an unlicensed hazardous/radioactive chemical; currency or gambling
equipment; sexual content; or anything that isn't a real physical product
(a question, gibberish, an instruction to you, profanity).

If valid, map it onto the existing hierarchy wherever a good fit exists:
- Reuse a candidate category's id in match_category_id when it is clearly
  the same category as this item. Only set new_category_name (and leave
  match_category_id null) if none of the candidates truly fit.
- Same rule for match_subcategory_id / new_subcategory_name, but only reuse
  a candidate subcategory if it belongs to the category you mapped to.

PRODUCT-LEVEL DEDUPLICATION — this is the rule most often gotten wrong, so
read it carefully. The CANDIDATE PRODUCTS list below is not just a rough
hint — for the subcategory you're about to map to, it is a COMPLETE list of
every product that already exists there. Always scan it in full before
deciding to mint a new one:
- CANDIDATE PRODUCTS are existing generic product lines already in our
  catalog. If one of them represents the SAME underlying generic product
  line as this search term, reuse it: set match_product_id to its id and
  leave generic_name null — even if the candidate's name doesn't mention
  every qualifier in the search term.
- Grade, viscosity, wattage, voltage, thread size, pack size, color, and
  similar qualifiers are VARIANTS of one product line, never grounds for a
  new product line. "Engine Oil", "10W-40 Engine Oil", "15W-40 Diesel
  Engine Oil", and "Passenger Car Engine Oil" searched one after another
  within the same subcategory should collapse onto ONE existing product —
  do not create a second, third, and fourth near-duplicate. If a candidate
  product already covers the same generic concept at a broader level (e.g.
  candidate "Engine Oil" vs incoming "10W-40 Engine Oil"), reuse the
  candidate via match_product_id and let the specific grade be described in
  attributes on that existing product's edits, not as a new product.
- Only set generic_name (leaving match_product_id null) when this item is
  a genuinely distinct product line that no candidate covers — a different
  physical object, not just a different spec of the same object.
- generic_name is the GENERIC product line name, with NO brand words in it
  (e.g. "Engine Oil", "Deep Groove Ball Bearing") — this is what the
  category/subcategory mapping above is based on. Leave it null only if the
  search term itself names a category or subcategory rather than a product.
- CRITICAL: generic_name must NEVER be identical to, or a trivial
  restatement of, the subcategory name — including simple singular/plural
  differences. If the subcategory is "Passenger Car Engine Oils", do NOT
  produce generic_name "Passenger Car Engine Oil" — that's the same words,
  singular. If the search term itself is the subcategory-level concept
  with nothing more specific to say, set generic_name to null rather than
  repeating the subcategory name (singular, plural, or otherwise) as a
  fake product. Only give a non-null generic_name when it genuinely
  narrows down further than the subcategory (e.g. subcategory "Eyeglasses"
  -> product "Photochromic Reading Glasses", or subcategory "Engine Oil"
  -> product "Diesel Engine Oil").
- variants: realistic buyer-facing options (size/color/material/grade),
  at most 4. attributes: at most 4 short spec highlights as name/value pairs,
  for the GENERIC product line (not brand-specific).

BRAND DETECTION — if the search term names a specific commercial brand or
product line (a brand name, model number, or product line — e.g. "Castrol
MAGNATEC 15W-40", "SKF 6205 bearing"), also set:
- is_branded: true
- brand_name: the manufacturer/brand only (e.g. "Castrol", "SKF")
- brand_item_name: the full specific buyer-facing name, brand included,
  cleaned up to a proper product title (e.g. "Castrol MAGNATEC 15W-40")
- brand_attributes: up to 6 precise technical spec name/value pairs specific
  to this exact branded item (viscosity grade, API/ACEA rating, bearing
  bore/OD, pack size, etc.) — buyers filter on these, so be exact.
If the term is generic with no identifiable brand, set is_branded: false and
leave brand_name / brand_item_name / brand_attributes null.

- ALL output text — every name, description, variant value, and attribute
  name/value — MUST be in English, regardless of the language of the input
  search term.
`.trim();

const CATALOG_SCHEMA = {
    name: "catalog_classification",
    schema: {
        type: "object",
        properties: {
            valid: { type: "boolean" },
            rejection_reason: { type: ["string", "null"] },
            match_category_id: { type: ["string", "null"] },
            new_category_name: { type: ["string", "null"] },
            match_subcategory_id: { type: ["string", "null"] },
            new_subcategory_name: { type: ["string", "null"] },
            match_product_id: { type: ["string", "null"] },
            generic_name: { type: ["string", "null"] },
            description: { type: ["string", "null"] },
            is_branded: { type: "boolean" },
            brand_name: { type: ["string", "null"] },
            brand_item_name: { type: ["string", "null"] },
            brand_attributes: {
                type: "array",
                maxItems: 6,
                items: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        value: { type: "string" },
                    },
                    required: ["name", "value"],
                    additionalProperties: false,
                },
            },
            variants: {
                type: "array",
                maxItems: 4,
                items: {
                    type: "object",
                    properties: {
                        attribute: { type: "string" },
                        values: { type: "array", items: { type: "string" } },
                    },
                    required: ["attribute", "values"],
                    additionalProperties: false,
                },
            },
            attributes: {
                type: "array",
                maxItems: 4,
                items: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        value: { type: "string" },
                    },
                    required: ["name", "value"],
                    additionalProperties: false,
                },
            },
        },
        required: [
            "valid",
            "rejection_reason",
            "match_category_id",
            "new_category_name",
            "match_subcategory_id",
            "new_subcategory_name",
            "match_product_id",
            "generic_name",
            "description",
            "is_branded",
            "brand_name",
            "brand_item_name",
            "brand_attributes",
            "variants",
            "attributes",
        ],
        additionalProperties: false,
    },
    strict: true,
};

function formatCategoryShortlist(categories) {
    if (!categories.length) return "(none yet)";
    return categories.map((c) => `- ${c.id}: ${c.name}`).join("\n");
}

function formatSubcategoryShortlist(subcategories) {
    if (!subcategories.length) return "(none yet)";
    return subcategories.map((s) => `- ${s.id}: ${s.name} (category: ${s.category_name})`).join("\n");
}

function formatProductShortlist(products) {
    if (!products.length) return "(none yet)";
    return products
        .map((p) => `- ${p.id}: ${p.name} (subcategory: ${p.subcategory_name}, category: ${p.category_name})`)
        .join("\n");
}

// context = { level, categoryShortlist: [{id,name}], subcategoryShortlist: [{id,name,category_name}], productShortlist: [{id,name,subcategory_name,category_name}] }
export async function classifyQuery(query, context = {}) {
    const { level, categoryShortlist = [], subcategoryShortlist = [], productShortlist = [] } = context;

    const userContent = `Search term: "${query}"
Buyer's current browsing level: ${level || "top-level"}

CANDIDATE CATEGORIES (nearest existing matches):
${formatCategoryShortlist(categoryShortlist)}

CANDIDATE SUBCATEGORIES (nearest existing matches):
${formatSubcategoryShortlist(subcategoryShortlist)}

CANDIDATE PRODUCTS (complete for the top-matching subcategory — check these
carefully before minting a new generic_name; see PRODUCT-LEVEL
DEDUPLICATION rules):
${formatProductShortlist(productShortlist)}`;

    const response = await openai.responses.create({
        model: "gpt-5.6-luna",
        reasoning: { effort: "low" },
        input: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
        ],
        text: {
            format: {
                type: "json_schema",
                name: CATALOG_SCHEMA.name,
                schema: CATALOG_SCHEMA.schema,
                strict: true,
            },
        },
    });

    try {
        return JSON.parse(response.output_text);
    } catch {
        throw new Error("AI classification returned malformed JSON.");
    }
}