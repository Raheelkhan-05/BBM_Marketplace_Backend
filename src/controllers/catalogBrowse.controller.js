import { supabase } from "../config/supabase.js";

// GET /api/catalog-search/browse
// One endpoint for everything the new unified page needs: items for the
// current filter set AND the facet option lists (with counts) to render
// the Subcategory/Product/Brand chips — all in a single DB round trip via
// the catalog_browse() Postgres function. This replaces the old separate
// searchSubcategoriesV2 / searchGenericProductsV2 / searchBrandItemsV2
// chain that the tile pages used to call one after another.
//
// Query params:
//   categoryId          - optional. Omit for global /browse search.
//   subcategoryIds       - comma-separated
//   genericProductIds    - comma-separated
//   brands                - comma-separated brand names
//   q                     - free text
//   sort                  - relevance | price_asc | price_desc
//   limit, offset
function splitParam(v) {
    if (!v) return null;
    const arr = String(v).split(",").map((s) => s.trim()).filter(Boolean);
    return arr.length ? arr : null;
}

export async function browseCatalog(req, res) {
    const {
        categoryId = null,
        subcategoryIds,
        genericProductIds,
        brands,
        q = "",
        sort = "relevance",
        limit = 24,
        offset = 0,
    } = req.query;

    const lim = Math.min(Math.max(Number(limit) || 24, 1), 60);
    const off = Math.max(Number(offset) || 0, 0);

    const { data, error } = await supabase.rpc("catalog_browse", {
        p_category_id: categoryId || null,
        p_subcategory_ids: splitParam(subcategoryIds),
        p_generic_product_ids: splitParam(genericProductIds),
        p_brand_names: splitParam(brands),
        p_q: q,
        p_sort: sort,
        p_limit: lim,
        p_offset: off,
        p_seller_id: req.sellerId || null, // added
    });

    if (error) return res.status(500).json({ success: false, message: error.message });

    res.json({ success: true, ...data });
}