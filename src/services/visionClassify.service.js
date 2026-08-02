// backend/services/fileImport/visionClassify.service.js
//
// Replaces geometric row-clustering entirely. Shows the model the actual
// rendered page (not just extracted text coordinates) and lets it
// identify every distinct product entry AND localize its photo, the same
// way a person — or ChatGPT reading an uploaded PDF — would.
import OpenAI from "openai";
import { CATALOG_SCHEMA, SYSTEM_PROMPT, formatCategoryShortlist, formatSubcategoryShortlist, formatProductShortlist } from "./openaiCatalog.service.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VISION_SYSTEM_PROMPT = `
${SYSTEM_PROMPT}

You are looking at ONE PAGE of a product catalog PDF, both as an image and
as its raw extracted text (the text may have jumbled column order — trust
your reading of the IMAGE for grouping decisions, use the text for exact
wording).

Identify every visually distinct product ENTRY on this page — a real
catalog row/block, not a section header, page title, footer, or table
column heading. A single entry may span several lines of text and include
a name, a description of usage/application, specs, and a photo.

For each entry, return:
- All the normal classification fields (see rules above).
- has_image: true/false — does this entry have its own distinct product
  photo on the page (not a shared logo/header image)?
- image_bbox: if has_image, the bounding box of JUST that product's photo
  in NORMALIZED 0-1 coordinates relative to the full page image:
  { x, y, width, height } where x/y is the top-left corner. Be tight and
  precise — do not include surrounding text or other products' photos.
  If has_image is false, set image_bbox to null.

Do not split one product's name/description/specs across multiple
entries just because they appear on separate lines — combine them into
one entry. Do not merge two visually distinct products into one entry
even if their text blocks are close together.
`.trim();

const VISION_SCHEMA = {
    name: "vision_page_classification",
    schema: {
        type: "object",
        properties: {
            items: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        ...CATALOG_SCHEMA.schema.properties,
                        has_image: { type: "boolean" },
                        image_bbox: {
                            type: ["object", "null"],
                            properties: {
                                x: { type: "number" }, y: { type: "number" },
                                width: { type: "number" }, height: { type: "number" },
                            },
                            required: ["x", "y", "width", "height"],
                            additionalProperties: false,
                        },
                    },
                    required: [...CATALOG_SCHEMA.schema.required, "has_image", "image_bbox"],
                    additionalProperties: false,
                },
            },
        },
        required: ["items"],
        additionalProperties: false,
    },
    strict: true,
};

export async function classifyPageVision({ pageImagePngBase64, rawPageText, shortlists }) {
    const userContent = [
        {
            type: "input_text",
            text: `RAW EXTRACTED TEXT FROM THIS PAGE (for reference only, may be jumbled):\n${rawPageText}\n\n` +
                `CANDIDATE CATEGORIES:\n${formatCategoryShortlist(shortlists.categories)}\n\n` +
                `CANDIDATE SUBCATEGORIES:\n${formatSubcategoryShortlist(shortlists.subcategories)}\n\n` +
                `CANDIDATE PRODUCTS:\n${formatProductShortlist(shortlists.products)}`,
        },
        {
            type: "input_image",
            image_url: `data:image/png;base64,${pageImagePngBase64}`,
        },
    ];

    const response = await openai.responses.create({
        model: "gpt-5.6-luna",
        reasoning: { effort: "medium" }, // bumped from "low" — this call now does layout + vision reasoning, not just text mapping
        input: [
            { role: "system", content: VISION_SYSTEM_PROMPT },
            { role: "user", content: userContent },
        ],
        text: { format: { type: "json_schema", name: VISION_SCHEMA.name, schema: VISION_SCHEMA.schema, strict: true } },
    });

    const { items } = JSON.parse(response.output_text);
    return items;
}