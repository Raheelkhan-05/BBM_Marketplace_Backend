// backend/services/brandSpecFill.service.js
//
// TWO calls, deliberately separated:
//   1. gatherFindings — web_search ON, free-text output. Research is
//      naturally citation-heavy; that's fine here, this text is never
//      shown to a buyer.
//   2. formatFindings — NO tools, forced strict schema, plain text only.
//      Reformats step 1's findings into clean key/value pairs. Because
//      this call never sees search results directly, it has nothing
//      citation-shaped to carry into the output.
// Sanitization (below) still runs as a hard backstop regardless.
import OpenAI from "openai";
import { sanitizeSpecValues } from "../utils/sanitizeSpecValue.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const FINDINGS_SYSTEM_PROMPT = `
You are researching the REAL technical specifications of one specific
branded/commercial product for a B2B marketplace. Search and report
factual findings in plain prose. For each requested field, either state
the real value plainly, or say "not found" if you can't confirm it — do
not guess or estimate. This is a research pass only; formatting happens
in a separate step, so write naturally, citations and all.
`.trim();

async function gatherFindings({ brandItemName, brandName, specSchema }) {
    const fieldList = specSchema.map((f) => `- ${f.label}${f.unit ? ` (${f.unit})` : ""}`).join("\n");
    const response = await openai.responses.create({
        model: "gpt-5.6-luna",
        reasoning: { effort: "medium" },
        tools: [{ type: "web_search" }],
        input: [
            { role: "system", content: FINDINGS_SYSTEM_PROMPT },
            { role: "user", content: `Product: "${brandItemName}" (brand: ${brandName || "unknown"})\n\nFind real values for:\n${fieldList}` },
        ],
    });
    return response.output_text || "";
}

const FORMAT_SYSTEM_PROMPT = `
Format research findings into structured spec values.
- Include a field ONLY if the findings state it with confidence. If
  findings say "not found", are vague, or don't mention it — OMIT it.
  Never fill with a guess or a typical/generic value.
- value must be PLAIN DATA ONLY: no URLs, no markdown links, no
  "(source: ...)", no citations, no brackets. Just the fact
  (e.g. "15W-40", never "15W-40 (source: xyz.com)").
- Numeric fields: number only, don't repeat a unit already in the schema.
`.trim();

const FORMAT_SCHEMA = {
    name: "brand_spec_values",
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

async function formatFindings({ findings, specSchema }) {
    const fieldsBlock = specSchema
        .map((f) => `- key: "${f.key}" | label: "${f.label}"${f.unit ? ` | unit: ${f.unit}` : ""}`)
        .join("\n");
    const response = await openai.responses.create({
        model: "gpt-5.6-luna",
        reasoning: { effort: "low" },
        input: [
            { role: "system", content: FORMAT_SYSTEM_PROMPT },
            { role: "user", content: `SCHEMA FIELDS:\n${fieldsBlock}\n\nRESEARCH FINDINGS:\n${findings}` },
        ],
        text: { format: { type: "json_schema", name: FORMAT_SCHEMA.name, schema: FORMAT_SCHEMA.schema, strict: true } },
    });
    try {
        return JSON.parse(response.output_text).values;
    } catch {
        return [];
    }
}

export async function fillBrandSpecValues({ brandItemName, brandName, specSchema, useWebSearch }) {
    if (!specSchema?.length) return { values: [], grounded: false, fillRate: 0 };

    let rawValues = [];
    let grounded = false;

    if (useWebSearch) {
        const findings = await gatherFindings({ brandItemName, brandName, specSchema });
        rawValues = await formatFindings({ findings, specSchema });
        grounded = rawValues.length > 0;
    }

    const validKeys = new Set(specSchema.map((f) => f.key));
    const cleaned = sanitizeSpecValues(rawValues.filter((v) => validKeys.has(v.key) && v.value?.trim()));

    return { values: cleaned, grounded, fillRate: cleaned.length / specSchema.length };
}