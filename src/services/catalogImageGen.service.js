// backend/services/catalogImageGen.service.js
//
// Generates a single square image with GPT Image 2 at "low" quality to
// keep cost down. Callers (category/subcategory/product) each build their
// own full prompt via plain string templates — no LLM call is spent on
// crafting the image prompt, which keeps this pipeline cheap regardless of
// how many new catalog entries get created.

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Returns a base64-encoded PNG string.
export async function generateCatalogImage(prompt) {
    const result = await openai.images.generate({
        model: "gpt-image-2",
        prompt,
        size: "1024x1024",
        quality: "low",
        background: "opaque",
    });

    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) throw new Error("GPT Image 2 returned no image data.");
    return b64;
}