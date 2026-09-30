// src/controllers/catalog.controller.js
//
// Thin pass-through controllers over the Postgres catalog_* functions —
// each one is a single RPC round trip, so latency here is basically just
// network + Postgres planning time. If you already have a catalog
// controller, merge these three handlers in; only getBrandItemDetail and
// getBrandItemSellers are new, getGenericProductBrands is your existing
// catalog_browse just called with a fixed p_generic_product_ids filter.
//
// CHANGED (this revision): getBrandItemSellers now forwards the buyer's
// destination pincode/state through to catalog_brand_item_sellers, and
// accepts a wider set of `sort` values ('moq_asc', 'fastest_delivery' —
// in addition to the existing 'relevance'/'price_asc'/'price_desc').
// The actual sorting/ordering across ALL matching sellers now happens
// inside the SQL function itself, not in the frontend — see that
// function's own comments for why (pagination-stable "fastest delivery"
// ordering).

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
        p_buyer_id: req.user?.id || null,
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
        p_buyer_id: req.user?.id || null,
    });

    if (error) {
        console.error("[catalog] getBrandItemDetail failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load this product's details." });
    }
    if (!data) return res.status(404).json({ success: false, message: "Product not found." });
    return res.json({ success: true, item: data });
}

// GET /api/catalog/brand-items/:brandItemId/sellers?sort=&limit=&offset=&destPincode=&destState=
//
// `sort` accepts: 'relevance' (default), 'price_asc', 'price_desc',
// 'moq_asc', or 'fastest_delivery'. The last one requires destPincode +
// destState (the buyer's saved delivery address) — without both, the SQL
// function simply can't compute a delivery estimate and 'fastest_delivery'
// silently behaves like 'relevance' (every seller ties, so the stable
// submission_id tiebreaker applies). destPincode/destState are optional
// for every other sort value too, but when present they're used to
// compute and return each seller's `total_delivery_days` so the frontend
// can DISPLAY an estimate even while sorting by price or MOQ.
export async function getBrandItemSellers(req, res) {
    const { brandItemId } = req.params;
    const { sort = "relevance", destPincode, destState } = req.query;
    const limit = parseIntSafe(req.query.limit, 24);
    const offset = parseIntSafe(req.query.offset, 0);

    const { data, error } = await supabaseAdmin.rpc("catalog_brand_item_sellers", {
        p_brand_item_id: brandItemId,
        p_sort: sort,
        p_limit: limit,
        p_offset: offset,
        p_buyer_id: req.user?.id || null,
        p_dest_pincode: destPincode || null,
        p_dest_state: destState || null,
        p_own_seller_id: req.sellerProfileId || null,
    });

    if (error) {
        console.error("[catalog] getBrandItemSellers failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load sellers right now." });
    }
    return res.json({ success: true, ...data });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/catalog/followed-ids
export async function getFollowedIds(req, res) {
    const { data, error } = await supabaseAdmin
        .from("buyer_followed_items")
        .select("brand_item_id")
        .eq("user_id", req.user.id);

    if (error) {
        console.error("[catalog] getFollowedIds failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load your followed products." });
    }
    return res.json({ success: true, ids: (data || []).map((r) => r.brand_item_id) });
}

// PUT /api/catalog/followed/:brandItemId  (idempotent)
export async function followBrandItem(req, res) {
    const { brandItemId } = req.params;
    if (!UUID_RE.test(brandItemId)) return res.status(400).json({ success: false, message: "Invalid product." });

    const { error } = await supabaseAdmin
        .from("buyer_followed_items")
        .upsert(
            { user_id: req.user.id, brand_item_id: brandItemId },
            { onConflict: "user_id,brand_item_id", ignoreDuplicates: true }
        );

    if (error) {
        if (error.code === "23503") return res.status(404).json({ success: false, message: "Product not found." });
        console.error("[catalog] followBrandItem failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't follow this product." });
    }
    return res.json({ success: true, following: true });
}

// DELETE /api/catalog/followed/:brandItemId  (idempotent)
export async function unfollowBrandItem(req, res) {
    const { brandItemId } = req.params;
    if (!UUID_RE.test(brandItemId)) return res.status(400).json({ success: false, message: "Invalid product." });

    const { error } = await supabaseAdmin
        .from("buyer_followed_items")
        .delete()
        .eq("user_id", req.user.id)
        .eq("brand_item_id", brandItemId);

    if (error) {
        console.error("[catalog] unfollowBrandItem failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't unfollow this product." });
    }
    return res.json({ success: true, following: false });
}

// GET /api/catalog/brand-items-feed?categoryId=&q=&sort=&limit=&offset=
// Home feed, one level flatter than getGenericProductsFeed — returns
// hs_generic_product_brands rows directly (same shape as
// getGenericProductBrands), scoped by category only, with no generic
// product picked yet. categoryId omitted = browse everything.
// GET /api/catalog/brand-items-feed?categoryId=&q=&sort=&limit=&offset=
export async function getBrandItemsFeed(req, res) {
    const { categoryId = "", q = "", sort = "relevance", destPincode, destState } = req.query;
    const limit = parseIntSafe(req.query.limit, 24);
    const offset = parseIntSafe(req.query.offset, 0);
    const followedOnly = req.query.followed === "1";
    const shop = String(req.query.shop || "").trim().slice(0, 100) || null;

    if (followedOnly && !req.user?.id) {
        return res.status(401).json({ success: false, message: "Login required." });
    }

    const { data, error } = await supabaseAdmin.rpc("catalog_browse_feed", {
        p_category_id: categoryId || null,
        p_q: q,
        p_sort: sort,
        p_limit: limit,
        p_offset: offset,
        p_seller_id: req.sellerProfileId || null,
        p_buyer_id: req.user?.id || null,
        p_followed_only: followedOnly,
        p_shop_slug: shop,
        p_dest_pincode: destPincode || null,
        p_dest_state: destState || null,
    });

    if (error) {
        console.error("[catalog] getBrandItemsFeed failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load products right now." });
    }
    const items = await attachPriceTrends({
        buyerId: req.user?.id,
        scope: shop ? `shop:${shop}` : "",
        items: data?.items,
    });
    return res.json({ success: true, ...data, items });
}

// GET /api/catalog/shops/:shopSlug  (public, only safe fields)
export async function getShopPublicInfo(req, res) {
    const slug = String(req.params.shopSlug || "").trim();
    if (!slug || slug.length > 100) {
        return res.status(400).json({ success: false, message: "Invalid store link." });
    }
    const { data, error } = await supabaseAdmin
        .from("seller_profiles")
        .select("shop_slug, display_name, city, state, logo_url")
        .eq("shop_slug", slug)
        .is("deleted_at", null)
        .maybeSingle();

    if (error) {
        console.error("[catalog] getShopPublicInfo failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load this store." });
    }
    if (!data) return res.status(404).json({ success: false, message: "Store not found." });
    res.set("Cache-Control", "public, max-age=60");
    return res.json({ success: true, shop: data });
}

// catalog.controller.js
export async function getBrandItemSellerOffer(req, res) {
    const { brandItemId } = req.params;
    const { shopSlug } = req.query;
    if (!shopSlug) return res.status(400).json({ success: false, message: "shopSlug is required." });

    const { data, error } = await supabaseAdmin.rpc("catalog_brand_item_seller_offer", {
        p_brand_item_id: brandItemId,
        p_shop_slug: shopSlug,
        p_buyer_id: req.user?.id || null,
    });

    if (!data.found) return res.status(404).json({ success: false, code: "LISTING_GONE", message: "This seller no longer has this listing available." });

    if (error) {
        console.error("[catalog] getBrandItemSellerOffer failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load this offer right now." });
    }
    if (!data?.item) return res.status(404).json({ success: false, message: "Product not found." });
    if (!data.found) return res.status(404).json({ success: false, message: "This seller no longer has this listing available." });
    return res.json({ success: true, item: data.item, offer: data.offer });
}

export async function getSharedProductLink(req, res) {
    const { submissionId } = req.params;
    // req.user is guaranteed here — the route below now requires auth —
    // so p_buyer_id is always a real id, never null.
    const { data, error } = await supabaseAdmin.rpc("catalog_shared_product_link", {
        p_submission_id: submissionId,
        p_buyer_id: req.user.id,
    });
    if (error) {
        console.error("[catalog] getSharedProductLink failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't load this link right now." });
    }
    if (!data) return res.status(404).json({ success: false, message: "This product link is no longer available." });
    if (data.restricted) {
        return res.status(403).json({ success: false, code: "RESTRICTED", message: "This product isn't available for your account. Ask the seller to add you." });
    }
    return res.json({ success: true, ...data });
}

// GET /api/seller-listing/lowest-price/:genericProductBrandId
// Returns the lowest active price for this brand item, normalized to
// "per Pack" so the frontend dial always seeds in the same unit the
// price field is edited in — regardless of what basis each individual
// seller happens to store their own price in.
export async function getLowestPriceForBrandItem(req, res) {
    const { genericProductBrandId } = req.params;
    if (!genericProductBrandId) return res.status(400).json({ success: false, message: "Missing genericProductBrandId." });

    const { data, error } = await supabaseAdmin
        .from("seller_product_submissions")
        .select("price, price_basis, pack_size, units_per_master_pack, gst_percent")
        .eq("generic_product_brand_id", genericProductBrandId)
        .eq("review_status", "approved")
        .eq("is_active", true)
        .not("price", "is", null);

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data?.length) return res.json({ success: true, lowestPricePerPack: null, sellerCount: 0 });

    // Normalize every row to "price per Pack" so they're comparable
    // regardless of what basis (per_unit / per_pack / per_master_pack)
    // that particular seller entered their price in.
    const perPackPrices = data.map((row) => {
        const price = Number(row.price) || 0;
        const pack = Number(row.pack_size) > 0 ? Number(row.pack_size) : 1;
        const master = Number(row.units_per_master_pack) > 0 ? Number(row.units_per_master_pack) : 1;
        if (row.price_basis === "per_unit") return price * pack;
        if (row.price_basis === "per_master_pack") return price / master;
        return price; // per_pack
    }).filter((p) => p > 0);

    if (!perPackPrices.length) return res.json({ success: true, lowestPricePerPack: null, sellerCount: 0 });

    res.json({
        success: true,
        lowestPricePerPack: Math.round(Math.min(...perPackPrices) * 100) / 100,
        sellerCount: perPackPrices.length,
    });
}


// ── Price-trend helpers ──────────────────────────────────────────────
// MUST match pricePerBaseUnit() in HomeProductFeed.jsx exactly.
function pricePerBaseUnit(price, packSize, masterPackSize) {
    const p = Number(price);
    if (!(p > 0)) return null;
    const pack = Number(packSize) > 0 ? Number(packSize) : 1;
    const master = Number(masterPackSize) > 0 ? Number(masterPackSize) : 1;
    return Math.round((p / (pack * master)) * 10000) / 10000;
}

// Same rule as catalog_browse_feed's ordering (SQL uses greatest(1, moq)).
function isRowOutOfStock(it) {
    return it.lowest_price_stock_type === "ready_stock"
        && Number(it.lowest_price_available_stock ?? 0) < Math.max(1, Number(it.lowest_price_moq) || 1);
}

// Reusable: call this from any endpoint that returns feed-shaped rows
// (e.g. catalog-search/products-merged). Never throws: a cosmetic feature
// must not be able to break the feed.
export async function attachPriceTrends({ buyerId, scope = "", items }) {
    try {
        if (!buyerId || !Array.isArray(items) || !items.length) return items;
        const obs = [];
        for (const it of items) {
            if (it.lowest_price == null || isRowOutOfStock(it)) continue;
            const ppu = pricePerBaseUnit(it.lowest_price, it.lowest_price_pack_size, it.lowest_price_master_pack_size);
            if (ppu != null) obs.push({ id: it.id, ppu });
        }
        if (!obs.length) return items.map((it) => ({ ...it, price_trend: null }));

        const { data, error } = await supabaseAdmin.rpc("catalog_record_price_trend", {
            p_buyer_id: buyerId, p_scope: scope, p_obs: obs,
        });
        if (error) {
            console.error("[catalog] attachPriceTrends failed:", error.message);
            return items; // price_trend stays undefined => frontend treats as "not tracked"
        }
        const map = data || {};
        return items.map((it) => ({ ...it, price_trend: map[it.id] ?? null }));
    } catch (e) {
        console.error("[catalog] attachPriceTrends threw:", e?.message);
        return items;
    }
}

// POST /api/catalog/price-trends/observe   body: { obs: [{ id, ppu }] }  (global scope only)
export async function observePriceTrends(req, res) {
    const raw = Array.isArray(req.body?.obs) ? req.body.obs.slice(0, 50) : [];
    const obs = [];
    for (const o of raw) {
        if (!UUID_RE.test(String(o?.id))) continue;
        const ppu = Number(o?.ppu);
        if (!Number.isFinite(ppu) || ppu <= 0 || ppu > 1e9) continue;
        obs.push({ id: o.id, ppu: Math.round(ppu * 10000) / 10000 });
    }
    if (!obs.length) return res.json({ success: true, trends: {} });

    const { data, error } = await supabaseAdmin.rpc("catalog_record_price_trend", {
        p_buyer_id: req.user.id, p_scope: "", p_obs: obs,
    });
    if (error) {
        console.error("[catalog] observePriceTrends failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't update price trends." });
    }
    return res.json({ success: true, trends: data || {} });
}