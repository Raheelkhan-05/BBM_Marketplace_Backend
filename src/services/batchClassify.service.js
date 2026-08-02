// backend/services/fileImport/batchClassify.service.js
import OpenAI from "openai";
import {
    CATALOG_SCHEMA,
    SYSTEM_PROMPT,
    formatCategoryShortlist,
    formatSubcategoryShortlist,
    formatProductShortlist,
} from "./openaiCatalog.service.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT_BATCH = `
${SYSTEM_PROMPT}

You will receive MULTIPLE rows in one call, each tagged "ROW <row_id>: <raw text>".
Classify EVERY row independently and completely on its own terms:
- NEVER borrow a spec, attribute, brand, or description from one row to
  fill in another row — even if two rows sit next to each other or look
  related. Each row's attributes/brand/variants must come ONLY from that
  row's own text.
- Return exactly one object per row_id you were given, in "items", with
  row_id echoed back unchanged. If a row's text is garbled or empty,
  still return an object for it with valid=false.
`.trim();

const BATCH_SCHEMA = {
    name: "batch_catalog_classification",
    schema: {
        type: "object",
        properties: {
            items: {
                type: "array",
                items: {
                    type: "object",
                    properties: { row_id: { type: "string" }, ...CATALOG_SCHEMA.schema.properties },
                    required: ["row_id", ...CATALOG_SCHEMA.schema.required],
                    additionalProperties: false,
                },
            },
        },
        required: ["items"],
        additionalProperties: false,
    },
    strict: true,
};

function formatShortlists({ categories, subcategories, products }) {
    return `CANDIDATE CATEGORIES:\n${formatCategoryShortlist(categories)}\n\nCANDIDATE SUBCATEGORIES:\n${formatSubcategoryShortlist(subcategories)}\n\nCANDIDATE PRODUCTS:\n${formatProductShortlist(products)}`;
}

export async function classifyBatch(rows, sharedShortlists) {
    const userContent = rows.map((r) => `ROW ${r.rowId}: "${r.rawText}"`).join("\n") + `\n\n${formatShortlists(sharedShortlists)}`;

    const response = await openai.responses.create({
        model: "gpt-5.6-luna",
        reasoning: { effort: "low" },
        input: [{ role: "system", content: SYSTEM_PROMPT_BATCH }, { role: "user", content: userContent }],
        text: { format: { type: "json_schema", name: BATCH_SCHEMA.name, schema: BATCH_SCHEMA.schema, strict: true } },
    });

    const { items } = JSON.parse(response.output_text);
    const byRowId = new Map(items.map((it) => [it.row_id, it]));
    return rows.map((r) => byRowId.get(r.rowId) || { row_id: r.rowId, valid: false, rejection_reason: "Model did not return a classification for this row." });
}