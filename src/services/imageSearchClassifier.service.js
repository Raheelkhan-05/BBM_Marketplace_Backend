// backend/services/imageSearchClassifier.service.js
//
// Takes a buyer-uploaded photo and turns it into a short marketplace search
// term (e.g. "ball bearing", "industrial lubricant") using GPT-5.6-Luna's
// vision input. This is a *search* step, not a catalog-write step — the
// resulting term is just fed back into the normal DB -> smart -> AI-resolve
// pipeline like any typed search, so it inherits all the same moderation.
//
// Still runs its own lightweight image-safety check up front so an
// obviously unsafe or irrelevant photo never even reaches a search term.

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `
You are BBM Marketplace's image search assistant (Brand Brigade Marketing
Pvt Ltd), a B2B industrial/commercial trading platform in India.

Look at the photo and identify the single main physical product in it.

Reject (valid=false, short buyer-facing rejection_reason) if the photo:
- Contains no identifiable physical product (e.g. a selfie, a screenshot,
  a document, a random scene, or is too blurry/unclear to identify)
- Shows a weapon/ammunition/explosive, a narcotic or drug paraphernalia,
  an endangered-species/wildlife product, human remains, sexual content,
  or anything else not legitimately tradable B2B

If valid, return a short (2-4 word) generic search term for the product a
buyer would type — no brand names, no marketing language, just the plain
product name (e.g. "ball bearing", "hex bolt", "office chair").
`.trim();

const SCHEMA = {
    name: "image_search_classification",
    schema: {
        type: "object",
        properties: {
            valid: { type: "boolean" },
            rejection_reason: { type: ["string", "null"] },
            search_term: { type: ["string", "null"] },
        },
        required: ["valid", "rejection_reason", "search_term"],
        additionalProperties: false,
    },
    strict: true,
};

// imageBase64: raw base64 (no data: prefix), mimeType e.g. "image/jpeg"
export async function classifyImageSearch(imageBase64, mimeType) {
    const response = await openai.responses.create({
        model: "gpt-5.6-luna",
        reasoning: { effort: "low" },
        input: [
            { role: "system", content: SYSTEM_PROMPT },
            {
                role: "user",
                content: [
                    { type: "input_text", text: "Identify the main product in this photo for a marketplace search." },
                    { type: "input_image", image_url: `data:${mimeType};base64,${imageBase64}` },
                ],
            },
        ],
        text: {
            format: {
                type: "json_schema",
                name: SCHEMA.name,
                schema: SCHEMA.schema,
                strict: true,
            },
        },
    });

    try {
        return JSON.parse(response.output_text);
    } catch {
        throw new Error("Image classification returned malformed JSON.");
    }
}