// src/controllers/catalog.controller.js
//
// Thin pass-through controllers over the Postgres catalog_* functions —
// each one is a single RPC round trip, so latency here is basically just
// network + Postgres planning time. If you already have a catalog
// controller, merge these three handlers in; only getBrandItemDetail and
// getBrandItemSellers are new, getGenericProductBrands is your existing
// catalog_browse just called with a fixed p_generic_product_ids filter.

import { supabaseAdmin } from "../config/supabase.js";

function parseIntSafe(v, fallback) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
}

// GET /api/catalog/categories/:categoryId/generic-products?q=&subcategoryIds=&sort=&limit=&offset=
export async function getCategoryGenericProducts(req, res) {
    const { categoryId } = req.params;
    const { q = "", sort = "relevance" } = req.query;
    const limit = parseIntSafe(req.query.limit, 30);
    const offset = parseIntSafe(req.query.offset, 0);
    const subcategoryIds = req.query.subcategoryIds
        ? String(req.query.subcategoryIds).split(",").filter(Boolean)
        : null;

    const { data, error } = await supabaseAdmin.rpc("catalog_browse_generic_products", {
        p_category_id: categoryId,
        p_subcategory_ids: subcategoryIds,
        p_q: q,
        p_sort: sort,
        p_limit: limit,
        p_offset: offset,
        p_seller_id: req.sellerProfileId || null, // set by an optional auth-aware middleware; null for guests
    });

    if (error) {
        console.error("[catalog] getCategoryGenericProducts failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load products right now." });
    }
    return res.json({ success: true, ...data });
}

// GET /api/catalog/generic-products?categoryId=&q=&subcategoryIds=&sort=&limit=&offset=
// Same RPC as getCategoryGenericProducts, but categoryId is optional — this is
// what powers the home feed. No category selected = browse everything, a
// category chip tapped = same call scoped down. No route change either way.
export async function getGenericProductsFeed(req, res) {
    const { categoryId = "", q = "", sort = "relevance" } = req.query;
    const limit = parseIntSafe(req.query.limit, 30);
    const offset = parseIntSafe(req.query.offset, 0);
    const subcategoryIds = req.query.subcategoryIds
        ? String(req.query.subcategoryIds).split(",").filter(Boolean)
        : null;

    const { data, error } = await supabaseAdmin.rpc("catalog_browse_generic_products", {
        p_category_id: categoryId || null,
        p_subcategory_ids: subcategoryIds,
        p_q: q,
        p_sort: sort,
        p_limit: limit,
        p_offset: offset,
        p_seller_id: req.sellerProfileId || null,
    });

    if (error) {
        console.error("[catalog] getGenericProductsFeed failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load products right now." });
    }
    return res.json({ success: true, ...data });
}

// GET /api/catalog/generic-products/:genericProductId/brands?q=&sort=&limit=&offset=
export async function getGenericProductBrands(req, res) {
    const { genericProductId } = req.params;
    const { q = "", sort = "relevance" } = req.query;
    const limit = parseIntSafe(req.query.limit, 30);
    const offset = parseIntSafe(req.query.offset, 0);

    const { data, error } = await supabaseAdmin.rpc("catalog_browse", {
        p_category_id: null,
        p_subcategory_ids: null,
        p_generic_product_ids: [genericProductId],
        p_brand_names: null,
        p_q: q,
        p_sort: sort,
        p_limit: limit,
        p_offset: offset,
        p_seller_id: req.sellerProfileId || null,
    });

    if (error) {
        console.error("[catalog] getGenericProductBrands failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load brands right now." });
    }
    return res.json({ success: true, ...data });
}

// GET /api/catalog/brand-items/:brandItemId
export async function getBrandItemDetail(req, res) {
    const { brandItemId } = req.params;
    const { data, error } = await supabaseAdmin.rpc("catalog_brand_item_detail", {
        p_brand_item_id: brandItemId,
    });

    if (error) {
        console.error("[catalog] getBrandItemDetail failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load this product's details." });
    }
    if (!data) return res.status(404).json({ success: false, message: "Product not found." });
    return res.json({ success: true, item: data });
}

// GET /api/catalog/brand-items/:brandItemId/sellers?sort=&limit=&offset=
export async function getBrandItemSellers(req, res) {
    const { brandItemId } = req.params;
    const { sort = "relevance" } = req.query;
    const limit = parseIntSafe(req.query.limit, 24);
    const offset = parseIntSafe(req.query.offset, 0);

    const { data, error } = await supabaseAdmin.rpc("catalog_brand_item_sellers", {
        p_brand_item_id: brandItemId,
        p_sort: sort,
        p_limit: limit,
        p_offset: offset,
    });

    if (error) {
        console.error("[catalog] getBrandItemSellers failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load sellers right now." });
    }
    return res.json({ success: true, ...data });
}

// GET /api/catalog/brand-items-feed?categoryId=&q=&sort=&limit=&offset=
// Home feed, one level flatter than getGenericProductsFeed — returns
// hs_generic_product_brands rows directly (same shape as
// getGenericProductBrands), scoped by category only, with no generic
// product picked yet. categoryId omitted = browse everything.
export async function getBrandItemsFeed(req, res) {
    const { categoryId = "", q = "", sort = "relevance" } = req.query;
    const limit = parseIntSafe(req.query.limit, 24);
    const offset = parseIntSafe(req.query.offset, 0);

    const { data, error } = await supabaseAdmin.rpc("catalog_browse", {
        p_category_id: categoryId || null,
        p_subcategory_ids: null,
        p_generic_product_ids: null,
        p_brand_names: null,
        p_q: q,
        p_sort: sort,
        p_limit: limit,
        p_offset: offset,
        p_seller_id: req.sellerProfileId || null,
    });

    if (error) {
        console.error("[catalog] getBrandItemsFeed failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load products right now." });
    }
    return res.json({ success: true, ...data });
}