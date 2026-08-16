import { supabase } from "../config/supabase.js";

// Rebuilds the shared home-feed cache by walking hs_categories and, for
// each one, pulling its first page of generic products via the SAME
// catalog_browse_generic_products RPC the live browse-products route
// uses (browseGenericProducts in catalogBrowse.controller.js). Only
// categories that come back with at least one item are kept — this is
// the server-side equivalent of the old frontend's resolveUpTo loop,
// just run once here instead of once per visitor's browser.

const CONCURRENCY = 4;
const SHELF_PRODUCT_LIMIT = 14;
const MAX_RESOLVED_SHELVES = 30;
const MAX_CATEGORIES_TO_SCAN = 60;

async function fetchAllCategories() {
    const { data, error } = await supabase
        .from("hs_categories")
        .select("id, name, slug, image")
        .eq("review_status", "approved")
        .order("name")
        .limit(MAX_CATEGORIES_TO_SCAN);
    if (error) throw error;
    return data || [];
}

// Mirrors browseGenericProducts — same RPC, same param shape, just
// called directly instead of over HTTP. p_seller_id is left null since
// this cache is shared across all visitors, not scoped to one seller.
async function getCategoryProducts(categoryId, limit) {
    const { data, error } = await supabase.rpc("catalog_browse_generic_products", {
        p_category_id: categoryId,
        p_subcategory_ids: null,
        p_q: "",
        p_sort: "relevance",
        p_limit: limit,
        p_offset: 0,
        p_seller_id: null,
    });
    if (error) throw error;
    // The RPC returns a jsonb payload; browseGenericProducts spreads it
    // as res.json({ success: true, ...data }), so data.items is the
    // product list (mirrors the shape paginatedResponse() uses elsewhere).
    return data?.items || [];
}

export async function refreshHomeFeedCache() {
    const categories = await fetchAllCategories();
    const resolved = [];
    let cursor = 0;

    while (cursor < categories.length && resolved.length < MAX_RESOLVED_SHELVES) {
        const batch = categories.slice(cursor, cursor + CONCURRENCY);
        cursor += batch.length;

        const results = await Promise.all(
            batch.map((cat) =>
                getCategoryProducts(cat.id, SHELF_PRODUCT_LIMIT).catch((err) => {
                    console.error(`home-feed: probe failed for category ${cat.id}`, err.message);
                    return [];
                })
            )
        );

        results.forEach((items, i) => {
            if (items.length > 0) resolved.push({ category: batch[i], items });
        });
    }

    const rows = resolved.slice(0, MAX_RESOLVED_SHELVES).map((s, idx) => ({
        shelf_order: idx,
        category_id: s.category.id,
        category: s.category,
        items: s.items,
        item_count: s.items.length,
        generated_at: new Date().toISOString(),
    }));

    // Wipe and reinsert. Not fully atomic against a read landing mid-swap,
    // but the refresh takes a couple seconds and runs every 20-30 min, so
    // the odds of a visitor hitting the gap are low. Say the word if you
    // want this upgraded to a blue/green (active-flag) swap instead.
    const { error: delErr } = await supabase.from("home_feed_cache").delete().neq("id", 0);
    if (delErr) throw delErr;

    if (rows.length > 0) {
        const { error: insErr } = await supabase.from("home_feed_cache").insert(rows);
        if (insErr) throw insErr;
    }

    return { shelfCount: rows.length };
}