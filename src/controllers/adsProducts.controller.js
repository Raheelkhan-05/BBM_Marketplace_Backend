// controllers/adsProducts.controller.js
// GET /api/ads/my-products?q=&offset=&limit=
// The seller's own live listings for "Promote this product" and "banner links to this product".
//
// Performance: the seller's full list is built once (paged submission reads + chunked catalog lookups),
// cached in memory for CACHE_TTL_MS, and every page / search is then sliced from that cached list. Scrolling
// and typing never fan out into extra DB queries. The cache is per server instance and short-lived, so a
// newly approved listing shows up within ~30 s.
import { supabaseAdmin } from "../config/supabase.js";

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_SELLERS = 200;
const DB_PAGE = 1000;     // Supabase's per-request row cap
const MAX_LISTINGS = 5000;
const LOOKUP_CHUNK = 100; // keeps the .in() URL short

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

const cache = new Map(); // sellerId -> { at, promise }

const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
};

async function buildCatalog(sellerId) {
    // 1. All live submissions (paged, in case a seller has more than 1000)
    const subs = [];
    for (let from = 0; from < MAX_LISTINGS; from += DB_PAGE) {
        const { data, error } = await supabaseAdmin
            .from("seller_product_submissions")
            .select("*")
            .eq("seller_id", sellerId)
            .eq("review_status", "approved")
            .eq("is_active", true)
            .order("id", { ascending: true })
            .range(from, from + DB_PAGE - 1);
        if (error) throw error;
        subs.push(...(data || []));
        if (!data || data.length < DB_PAGE) break;
    }

    const now = Date.now();
    const live = subs.filter((s) => !s.expires_at || new Date(s.expires_at).getTime() > now);

    // 2. Catalog items, fetched in parallel chunks
    const ids = [...new Set(live.map((s) => s.generic_product_brand_id).filter(Boolean))];
    const byId = new Map();
    const results = await Promise.all(
        chunk(ids, LOOKUP_CHUNK).map((part) =>
            supabaseAdmin.from("hs_generic_product_brands").select("*").in("id", part)
        )
    );
    for (const { data, error } of results) {
        if (error) throw error;
        for (const b of data || []) byId.set(b.id, b);
    }

    // 3. Shape, sort, and pre-compute a lowercase search string
    return live
        .map((s) => {
            const b = byId.get(s.generic_product_brand_id);
            if (!b) return null;
            const product = {
                submissionId: s.id,
                name: b.name,
                brandName: b.brand_name || null,
                image: b.image || b.brand_image || null,
                price: Number(s.price) || 0,
                unit: s.unit || null,
                masterPackSize: s.units_per_master_pack ?? null,
            };
            return { s: `${product.name || ""} ${product.brandName || ""}`.toLowerCase(), p: product };
        })
        .filter(Boolean)
        .sort((a, b) => String(a.p.name).localeCompare(String(b.p.name)) || String(a.p.submissionId).localeCompare(String(b.p.submissionId)));
}

function getCatalog(sellerId) {
    const now = Date.now();
    const hit = cache.get(sellerId);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.promise;

    const promise = buildCatalog(sellerId).catch((e) => {
        if (cache.get(sellerId)?.promise === promise) cache.delete(sellerId); // never cache a failure
        throw e;
    });
    cache.set(sellerId, { at: now, promise });

    if (cache.size > CACHE_MAX_SELLERS) {
        for (const [k, v] of cache) { if (now - v.at >= CACHE_TTL_MS) cache.delete(k); }
        while (cache.size > CACHE_MAX_SELLERS) cache.delete(cache.keys().next().value); // oldest first
    }
    return promise;
}

export async function getMyAdProducts(req, res) {
    try {
        const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const tokens = String(req.query.q ?? "").trim().slice(0, 80).toLowerCase().split(/\s+/).filter(Boolean);

        const catalog = await getCatalog(req.sellerId);
        const matched = tokens.length ? catalog.filter((x) => tokens.every((t) => x.s.includes(t))) : catalog;

        const page = matched.slice(offset, offset + limit).map((x) => x.p);
        const nextOffset = offset + page.length;

        res.set("Cache-Control", "private, no-store");
        return res.json({
            success: true,
            products: page,
            total: matched.length,   // matches for this search
            totalAll: catalog.length, // all live products (lets the UI decide whether to show the search bar)
            nextOffset,
            hasMore: nextOffset < matched.length,
        });
    } catch (e) {
        console.error("[ads] my-products failed:", e?.message || e, e?.details || "", e?.hint || "");
        return res.status(500).json({
            success: false,
            message: "Couldn't load your products.",
            ...(process.env.NODE_ENV !== "production" ? { details: e?.message || String(e) } : {}),
        });
    }
}