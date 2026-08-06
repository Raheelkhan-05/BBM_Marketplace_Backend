// backend/services/specSchema.service.js
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `
You define comparison schemas for a marketplace spanning every kind of
physical product — electronics, vehicles, industrial fluids, paints,
tyres, apparel, hardware, anything.

Given a generic product line, output the FULL set of specifications a
real buyer would expect on a proper manufacturer spec sheet or a
dedicated spec-comparison site for that exact category — e.g. a phone's
GSMArena page, a car's official brochure spec table, an engine oil's
technical data sheet, a tyre's manufacturer spec card.

Rules:
- Be THOROUGH, not minimal. Most real products need 12-24 fields covering
  every dimension a buyer actually compares on. Only use fewer (as low as
  3) for genuinely simple, single-purpose items where padding would be
  fake filler. Phones, laptops, cars, bikes, engine oils, paints, and
  tyres should almost always land at the high end — these categories have
  well-established spec conventions; use them.
- Group fields under real-world section headers a buyer would recognize
  — e.g. phone: "Display", "Performance", "Camera", "Battery",
  "Connectivity", "Build & Design"; car: "Engine", "Performance",
  "Dimensions & Weight", "Fuel Economy", "Safety", "Infotainment"; engine
  oil: "Performance Grade", "Physical Properties", "Packaging". Every
  field belongs to exactly one group.
- "key": stable snake_case identifier. Never changes once picked.
- "label": buyer-facing name, worded exactly as a real spec sheet would.
- "type":
   - "numeric" for a single measurable quantity (set "unit").
   - "enum" for a fixed real-world category (transmission type, fuel type).
   - "list" for fields where ONE item legitimately has multiple
     simultaneous values — storage tiers, color options, supported
     network bands, safety certifications. Never use "numeric" for these
     — it breaks range math on the comparison table.
   - "text" for anything descriptive but not neatly categorical.
- "unit": only for "numeric" fields, else null.
- "importance": 1 (primary purchase driver), 2 (secondary), 3 (nice-to-know).
- Order fields by group, then importance within group.
- Tailor fields to THIS EXACT product like an expert in that specific
  industry would build a spec sheet for it. Never reuse one category's
  schema shape for a different one.
`.trim();

const SCHEMA = {
    name: "spec_schema",
    schema: {
        type: "object",
        properties: {
            fields: {
                type: "array", minItems: 3, maxItems: 24,
                items: {
                    type: "object",
                    properties: {
                        key: { type: "string" },
                        label: { type: "string" },
                        group: { type: "string" },
                        type: { type: "string", enum: ["numeric", "enum", "list", "text"] },
                        unit: { type: ["string", "null"] },
                        importance: { type: "integer", enum: [1, 2, 3] },
                    },
                    required: ["key", "label", "group", "type", "unit", "importance"],
                    additionalProperties: false,
                },
            },
        },
        required: ["fields"],
        additionalProperties: false,
    },
    strict: true,
};

export async function generateSpecSchema({ genericName, categoryName, subcategoryName, description }) {
    const userContent = `Product line: "${genericName}"
Category: ${categoryName || "(unknown)"}
Subcategory: ${subcategoryName || "(unknown)"}
Description: ${description || "(none)"}`;

    const response = await openai.responses.create({
        model: "gpt-5.6-luna",
        reasoning: { effort: "medium" }, // bumped from "low" — schema quality gates every downstream spec value, worth the extra cost once per product line
        input: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }],
        text: { format: { type: "json_schema", name: SCHEMA.name, schema: SCHEMA.schema, strict: true } },
    });

    try {
        const fields = JSON.parse(response.output_text).fields;
        const groupOrder = [];
        for (const f of fields) if (!groupOrder.includes(f.group)) groupOrder.push(f.group);
        return [...fields].sort((a, b) => {
            const g = groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group);
            return g !== 0 ? g : a.importance - b.importance;
        });
    } catch {
        return [];
    }
}