// backend/controllers/sellerCatalogListings.controller.js
//
// Seller self-publish — pure data capture, no review/approval workflow.
// Sellers pick a category > subcategory > product from the EXISTING,
// already-approved taxonomy (hs_categories / hs_subcategories /
// hs_products — untouched by this file), fill in whatever fields
// seller_listing_field_defs currently defines, and the submission is
// stored as-is.
//
// To change what a seller is asked for — add a field, remove one, flip
// required/optional — edit the seller_listing_field_defs table directly
// in Supabase. Nothing here needs to change.

import { supabase } from "../config/supabase.js";

const PICKER_LIMIT = 20;

// ---------------------------------------------------------------------------
// Picker endpoints — approved-only versions of the general search endpoints.
// ---------------------------------------------------------------------------

// GET /api/seller/catalog/categories?q=
export async function listApprovedCategories(req, res) {
    const { q = "" } = req.query;
    let query = supabase
        .from("hs_categories")
        .select("id, name, slug, image")
        .eq("review_status", "approved")
        .order("name")
        .limit(PICKER_LIMIT);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

// GET /api/seller/catalog/subcategories?categoryId=&q=
export async function listApprovedSubcategories(req, res) {
    const { categoryId, q = "" } = req.query;
    if (!categoryId) return res.status(400).json({ success: false, message: "categoryId is required." });

    let query = supabase
        .from("hs_subcategories")
        .select("id, name, slug, image, category_id")
        .eq("category_id", categoryId)
        .eq("review_status", "approved")
        .order("name")
        .limit(PICKER_LIMIT);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

// GET /api/seller/catalog/products?subcategoryId=&q=
export async function listApprovedProducts(req, res) {
    const { subcategoryId, q = "" } = req.query;
    if (!subcategoryId) return res.status(400).json({ success: false, message: "subcategoryId is required." });

    let query = supabase
        .from("hs_products")
        .select("id, name, slug, image, description, spec_schema, subcategory_id")
        .eq("subcategory_id", subcategoryId)
        .eq("review_status", "approved")
        .order("name")
        .limit(PICKER_LIMIT);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({
        success: true,
        items: (data || []).map((p) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            image: p.image,
            description: p.description,
            hasSpecSchema: Array.isArray(p.spec_schema) && p.spec_schema.length > 0,
        })),
    });
}

// GET /api/seller/catalog/products/:productId/schema
// Product-specific technical spec fields (unchanged — still lives on
// hs_products.spec_schema, separate from the generic fields below).
export async function getProductSchema(req, res) {
    const { productId } = req.params;

    const { data: product, error } = await supabase
        .from("hs_products")
        .select(`
            id, name, description, spec_schema, review_status,
            subcategory:hs_subcategories (
                id, name,
                category:hs_categories ( id, name )
            )
        `)
        .eq("id", productId)
        .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!product) return res.status(404).json({ success: false, message: "Product not found." });
    if (product.review_status !== "approved") {
        return res.status(400).json({ success: false, message: "This product hasn't been approved yet, so it can't be listed under." });
    }

    const specSchema = Array.isArray(product.spec_schema) ? product.spec_schema : [];

    res.json({
        success: true,
        category: product.subcategory?.category ? { id: product.subcategory.category.id, name: product.subcategory.category.name } : null,
        subcategory: product.subcategory ? { id: product.subcategory.id, name: product.subcategory.name } : null,
        product: { id: product.id, name: product.name, description: product.description },
        specSchema,
        hasSpecSchema: specSchema.length > 0,
    });
}

// ---------------------------------------------------------------------------
// Listing field definitions — the generic (non-product-specific) part of
// the form. Add/remove/reorder/require rows in seller_listing_field_defs
// directly in Supabase; this endpoint just reflects whatever is there.
// ---------------------------------------------------------------------------

// GET /api/seller/catalog/listing-fields
export async function getListingFieldDefs(req, res) {
    const { data, error } = await supabase
        .from("seller_listing_field_defs")
        .select("field_key, label, field_type, options, unit, is_required, step, display_order, help_text")
        .eq("is_active", true)
        .order("step")
        .order("display_order");

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, fields: data || [] });
}

// ---------------------------------------------------------------------------
// Listing creation — requires requireApprovedSeller upstream
// ---------------------------------------------------------------------------

function validateAgainstFieldDefs(data, fieldDefs) {
    const missing = [];
    for (const field of fieldDefs) {
        if (!field.is_required) continue;
        const v = data?.[field.field_key];
        const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
        if (empty) missing.push(field.label || field.field_key);
    }
    return missing;
}

function validateAgainstSpecSchema(specifications, specSchema) {
    const missing = [];
    const specByKey = Object.fromEntries((specifications || []).map((s) => [s.key, s.value]));
    for (const field of specSchema || []) {
        if (!field.required) continue;
        const v = specByKey[field.key];
        if (v === undefined || v === null || v === "") missing.push(field.label || field.key);
    }
    return missing;
}

// POST /api/seller/catalog/listings
// Body: { productId, data: { field_key: value, ... }, specifications: [{ key, value }] }
export async function createListing(req, res) {
    const sellerId = req.sellerId;
    const { productId, data = {}, specifications = [] } = req.body || {};

    if (!productId) return res.status(400).json({ success: false, message: "Please choose a product." });

    const { data: product, error: productErr } = await supabase
        .from("hs_products")
        .select("id, name, spec_schema, review_status, subcategory:hs_subcategories(id, category:hs_categories(id))")
        .eq("id", productId)
        .maybeSingle();

    if (productErr) return res.status(500).json({ success: false, message: productErr.message });
    if (!product) return res.status(400).json({ success: false, message: "Selected product wasn't found." });
    if (product.review_status !== "approved") {
        return res.status(400).json({ success: false, message: "This product hasn't been approved yet — it can't be listed under." });
    }
    if (!product.subcategory?.id || !product.subcategory?.category?.id) {
        return res.status(400).json({ success: false, message: "This product is missing category information — please contact support." });
    }

    const { data: fieldDefs, error: fieldErr } = await supabase
        .from("seller_listing_field_defs")
        .select("field_key, label, is_required")
        .eq("is_active", true);
    if (fieldErr) return res.status(500).json({ success: false, message: fieldErr.message });

    const specSchema = Array.isArray(product.spec_schema) ? product.spec_schema : [];

    const missing = [
        ...validateAgainstFieldDefs(data, fieldDefs || []),
        ...validateAgainstSpecSchema(specifications, specSchema),
    ];
    if (missing.length) {
        return res.status(400).json({ success: false, message: `Please provide: ${[...new Set(missing)].join(", ")}.`, missing });
    }

    const { data: inserted, error } = await supabase
        .from("seller_product_listings")
        .insert({
            seller_id: sellerId,
            product_id: product.id,
            subcategory_id: product.subcategory.id,
            category_id: product.subcategory.category.id,
            data,
            specifications,
        })
        .select("id, created_at")
        .single();

    if (error) return res.status(500).json({ success: false, message: error.message });

    res.json({ success: true, listing: inserted, message: "Your product details have been saved." });
}

// GET /api/seller/catalog/listings
export async function listMyListings(req, res) {
    const sellerId = req.sellerId;

    const { data, error } = await supabase
        .from("seller_product_listings")
        .select("id, data, specifications, created_at, product:hs_products(id, name)")
        .eq("seller_id", sellerId)
        .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}