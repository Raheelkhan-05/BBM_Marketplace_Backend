// backend/services/openaiCatalog.service.js
//
// Wraps GPT-5.6-Luna to do three things in one cheap call:
//   1. Moderation — refuse anything that isn't a legitimate, legally
//      tradable B2B/industrial good.
//   2. Mapping — reuse an existing category/subcategory when one of the
//      embedding-shortlisted candidates is clearly the same thing, instead
//      of creating near-duplicates like "Stationery" vs "Office Supplies".
//   3. Enrichment — generic name, short description, variants, attributes.
//
// No web_search tool here on purpose: everyday product classification
// doesn't need it, and it was the single biggest token cost in earlier
// versions of this service (search results get pulled into context on
// every call). Reasoning effort is kept at "low" — enough for reliable
// moderation + mapping on short inputs like this without paying for more.

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
- Keep any new category/subcategory name short and buyer-recognizable.
- generic_name is the GENERIC product line name, with NO brand words in it
  (e.g. "Engine Oil", "Deep Groove Ball Bearing") — this is what the
  category/subcategory mapping above is based on. Leave it null only if the
  search term itself names a category or subcategory rather than a product.
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

// context = { level, categoryShortlist: [{id,name}], subcategoryShortlist: [{id,name,category_name}] }
export async function classifyQuery(query, context = {}) {
    const { level, categoryShortlist = [], subcategoryShortlist = [] } = context;

    const userContent = `Search term: "${query}"
Buyer's current browsing level: ${level || "top-level"}

CANDIDATE CATEGORIES (nearest existing matches):
${formatCategoryShortlist(categoryShortlist)}

CANDIDATE SUBCATEGORIES (nearest existing matches):
${formatSubcategoryShortlist(subcategoryShortlist)}`;

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