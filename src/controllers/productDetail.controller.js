// backend/controllers/productDetail.controller.js
import { supabase } from "../config/supabase.js";

// ---- spec aggregation ----
//
// A generic product page was showing whatever fixed attributes the AI
// guessed at creation time — sometimes literally one specific SKU's exact
// spec sheet (e.g. "Processor: Intel Core Ultra 5 125H" on a generic
// "Laptop" product), never revisited as real brand listings piled up
// underneath it. This aggregates the real attribute values actually
// present across those brand listings and turns them into honest ranges
// (numeric specs like weight/display size) or option sets (categorical
// specs like processor/color) — the same way a real marketplace's
// product-line page works. Pure JS, no external calls, so it adds no LLM
// cost per request.
const NUMERIC_UNIT_RE = /^(-?[\d.]+)\s*([a-zA-Z%]+)$/;

function tryParseNumericUnit(value) {
    const match = NUMERIC_UNIT_RE.exec(String(value).trim());
    if (!match) return null;
    const num = parseFloat(match[1]);
    if (Number.isNaN(num)) return null;
    return { num, unit: match[2].toLowerCase() };
}

function summarizeAttributeValues(name, rawValues) {
    const values = [...new Set(rawValues.filter(Boolean).map((v) => String(v).trim()))];
    if (values.length === 0) return null;
    if (values.length === 1) return { name, values, rangeText: values[0] };

    // If every value parses as "<number><unit>" with a consistent unit,
    // show a min–max range instead of a flat list (e.g. "1.2kg – 2.4kg").
    const parsed = values.map(tryParseNumericUnit);
    const allNumeric = parsed.every(Boolean);
    const sameUnit = allNumeric && parsed.every((p) => p.unit === parsed[0].unit);
    if (allNumeric && sameUnit) {
        const nums = parsed.map((p) => p.num);
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        const unit = parsed[0].unit;
        return { name, values, rangeText: min === max ? `${min}${unit}` : `${min}${unit} – ${max}${unit}` };
    }

    // Otherwise: a capped, readable option list (e.g. "Intel Core i5, i7,
    // Ultra 5, Ultra 7, +2 more").
    const MAX_LISTED = 6;
    const shown = values.slice(0, MAX_LISTED);
    const extra = values.length - shown.length;
    return { name, values, rangeText: shown.join(", ") + (extra > 0 ? `, +${extra} more` : "") };
}

function buildSpecSummary(productAttributes, brandRows) {
    const byName = new Map();
    const addAll = (attrs) => {
        if (!attrs || typeof attrs !== "object") return;
        for (const [name, value] of Object.entries(attrs)) {
            if (!byName.has(name)) byName.set(name, []);
            byName.get(name).push(value);
        }
    };

    addAll(productAttributes);
    for (const b of brandRows) addAll(b.attributes);

    const summary = [];
    for (const [name, rawValues] of byName) {
        const entry = summarizeAttributeValues(name, rawValues);
        if (entry) summary.push(entry);
    }
    return summary;
}

// GET /api/products/:id
// Single product page — pulls the product itself, its category chain, the
// brands that sell it, an aggregated spec summary across those brands, and
// how many active sellers list it.
export async function getProductDetail(req, res) {
    const { id } = req.params;
    const { data: product, error } = await supabase
        .from("hs_products")
        .select(`
            id, name, slug, image, description, generic_name,
            variants, attributes, is_ai_generated,
            subcategory:hs_subcategories (
                id, name, slug,
                category:hs_categories ( id, name, slug )
            )
        `)
        .eq("id", id)
        .single();
    if (error || !product) {
        return res.status(404).json({ success: false, message: "Product not found." });
    }

    const [brandsRes, sellerCountRes] = await Promise.all([
        supabase
            .from("hs_product_brands")
            // widened from 12 -> 50 so the spec aggregation below reflects
            // the real spread of listings, not just the first page of them
            .select("id, name, brand_name, image, slug, attributes")
            .eq("product_id", id)
            .order("name")
            .limit(50),
        supabase
            .from("hs_product_sellers")
            .select("id", { count: "exact", head: true })
            .eq("product_id", id)
            .eq("is_active", true),
    ]);

    const brandRows = brandsRes.data || [];
    const specSummary = buildSpecSummary(product.attributes, brandRows);

    res.json({
        success: true,
        product,
        // attributes were only needed here for aggregation, no need to ship
        // them to the client per-brand
        brands: brandRows.map(({ attributes, ...rest }) => rest),
        specSummary,
        specSampleSize: brandRows.length,
        sellerCount: sellerCountRes.count || 0,
    });
}