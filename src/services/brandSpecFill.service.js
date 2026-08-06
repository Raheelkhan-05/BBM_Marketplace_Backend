// backend/services/brandSpecFill.service.js
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `
You fill REAL, VERIFIED technical specifications for one specific branded
product, against a fixed comparison schema.

Your goal is a spec sheet as complete and detailed as the manufacturer's
own official spec page — buyers rely on this for a real purchase
decision, so thoroughness matters as much as accuracy.

For each field: if you're confident of the TRUE real spec (from knowledge
or search results), include it. If a field is type "list", include every
real value that applies (all storage tiers, all color options, all
certifications) as one comma-separated string, in natural/ascending
order — don't pick just one when several genuinely apply.

Only leave a field out if you've genuinely tried to find it and are still
not confident — not just because it wasn't in the first result you saw.
Never guess, estimate, or infer from "typical" products in this category.
A shorter honest response beats a complete but inaccurate one — but check
thoroughly before calling a field unknown.

Numeric fields: just the number (unit is already known from the schema).
`.trim();

const SCHEMA = {
    name: "brand_spec_fill",
    schema: {
        type: "object",
        properties: {
            values: {
                type: "array",
                items: {
                    type: "object",
                    properties: { key: { type: "string" }, value: { type: "string" } },
                    required: ["key", "value"], additionalProperties: false,
                },
            },
        },
        required: ["values"], additionalProperties: false,
    },
    strict: true,
};

export async function fillBrandSpecValues({ brandItemName, brandName, specSchema, useWebSearch }) {
    if (!specSchema?.length) return { values: [], grounded: false };

    const fieldsBlock = specSchema
        .map((f) => `- ${f.key} ("${f.label}", group: ${f.group}, type: ${f.type}${f.unit ? `, unit: ${f.unit}` : ""})`)
        .join("\n");

    const userContent = `Branded product: "${brandItemName}"
Brand: ${brandName || "(unknown)"}

SCHEMA FIELDS — aim to fill as many as you can genuinely verify:
${fieldsBlock}`;

    const response = await openai.responses.create({
        model: "gpt-5.6-luna",
        reasoning: { effort: useWebSearch ? "medium" : "low" }, // bumped from "medium"
        tools: useWebSearch ? [{ type: "web_search" }] : undefined,
        input: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }],
        text: { format: { type: "json_schema", name: SCHEMA.name, schema: SCHEMA.schema, strict: true } },
    });

    try {
        const { values } = JSON.parse(response.output_text);
        const validKeys = new Set(specSchema.map((f) => f.key));
        return { values: values.filter((v) => validKeys.has(v.key) && v.value?.trim()), grounded: useWebSearch };
    } catch {
        return { values: [], grounded: false };
    }
}