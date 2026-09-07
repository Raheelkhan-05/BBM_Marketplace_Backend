import { supabase } from "../config/supabase.js";

// Admin-approved-only hierarchy search: Category -> Subcategory ->
// Generic Product -> Brand Item -> Sellers. Every level is filtered to
// review_status = 'approved' — nothing here is ever AI-created on the
// fly or shown pending review. This is a parallel, additive module; the
// original AI-resolver hierarchy (hierarchysearch.controller.js) is
// untouched and still serves whatever still points at it.

const DEFAULT_LIMIT = 20;
function clampLimit(limit) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
    return Math.min(n, 50);
}
function clampOffset(offset) {
    const n = Number(offset);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
}

// Search terms can contain characters that are meaningful to Postgres'
// ILIKE (%, _) or to PostgREST's .or() filter syntax (,  ( ) ") — e.g.
// "Exotes ... 200 g 8% off" has both a comma and a percent sign. Left
// unescaped, the comma splits the .or() string into a bogus extra
// condition and the % is read as a wildcard instead of a literal char,
// so the search silently fails to match. These two helpers make any
// user-supplied term safe to drop into either context.

// Escapes ILIKE wildcard characters so they're matched literally.
function escapeIlike(term) {
    return term.replace(/[%_\\]/g, (m) => `\\${m}`);
}

// Plain %term% ILIKE pattern (safe to pass to .ilike(), which takes the
// pattern as its own argument and never shares a string with other
// filters — no comma-escaping needed here, just the wildcard escaping).
function ilikePattern(term) {
    return `%${escapeIlike(term)}%`;
}

// Builds a %term% ILIKE pattern, then quotes it per PostgREST's rules so
// it can safely sit inside a comma-separated .or() filter list even if
// the term itself contains commas, parentheses, or quotes.
function orIlikePattern(term) {
    const pattern = ilikePattern(term);
    return `"${pattern.replace(/"/g, '\\"')}"`;
}

// Every paginated list endpoint follows the same shape: fetch lim+1 rows
// via .range() so we know if there's another page without a separate
// count query, then slice back down to lim before responding.
function paginatedResponse(res, level, rows, lim, off) {
    const hasMore = rows.length > lim;
    const items = hasMore ? rows.slice(0, lim) : rows;
    res.json({ success: true, level, items, hasMore, nextOffset: off + items.length });
}

// GET /api/catalog-search/categories?q=&limit=&offset=
export async function searchCategoriesV2(req, res) {
    const { q = "", limit, offset } = req.query;
    const lim = clampLimit(limit);
    const off = clampOffset(offset);

    let query = supabase
        .from("hs_categories")
        .select("id, name, slug, image")
        .eq("review_status", "approved")
        .order("name")
        .range(off, off + lim); // fetch lim+1 to detect hasMore
    if (q.trim()) query = query.ilike("name", ilikePattern(q.trim()));

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    paginatedResponse(res, "category", data || [], lim, off);
}

// GET /api/catalog-search/subcategories?categoryId=&q=&limit=&offset=
export async function searchSubcategoriesV2(req, res) {
    const { categoryId, q = "", limit, offset } = req.query;
    if (!categoryId) return res.status(400).json({ success: false, message: "categoryId is required." });
    const lim = clampLimit(limit);
    const off = clampOffset(offset);

    let query = supabase
        .from("hs_subcategories")
        .select("id, category_id, name, slug, image")
        .eq("category_id", categoryId)
        .eq("review_status", "approved")
        .order("name")
        .range(off, off + lim);
    if (q.trim()) query = query.ilike("name", ilikePattern(q.trim()));

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    paginatedResponse(res, "subcategory", data || [], lim, off);
}

// GET /api/catalog-search/generic-products?subcategoryId=&q=&limit=&offset=
export async function searchGenericProductsV2(req, res) {
    const { subcategoryId, q = "", limit, offset } = req.query;
    if (!subcategoryId) return res.status(400).json({ success: false, message: "subcategoryId is required." });
    const lim = clampLimit(limit);
    const off = clampOffset(offset);

    let query = supabase
        .from("hs_generic_products")
        .select("id, subcategory_id, name, slug, image")
        .eq("subcategory_id", subcategoryId)
        .eq("review_status", "approved")
        .order("name")
        .range(off, off + lim);
    if (q.trim()) query = query.ilike("name", ilikePattern(q.trim()));

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    paginatedResponse(res, "generic_product", data || [], lim, off);
}

// GET /api/catalog-search/brand-items?genericProductId=&q=&limit=&offset=
// Each item also carries sellerCount + lowestPrice, computed only from
// APPROVED seller listings — so pricing shown to buyers is always real
// and reviewed, even though the brand item's own approval is separate
// from any particular seller's listing approval. Only the brand-item
// query itself is paginated; the follow-up stats query stays scoped to
// exactly the ids on the current page.
export async function searchBrandItemsV2(req, res) {
    const { genericProductId, q = "", limit, offset } = req.query;
    if (!genericProductId) return res.status(400).json({ success: false, message: "genericProductId is required." });
    const lim = clampLimit(limit);
    const off = clampOffset(offset);

    let query = supabase
        .from("hs_generic_product_brands")
        .select("id, generic_product_id, name, brand_name, slug, image, images")
        .eq("generic_product_id", genericProductId)
        .eq("review_status", "approved")
        .order("name")
        .range(off, off + lim);
    if (q.trim()) {
        const p = orIlikePattern(q.trim());
        query = query.or(`name.ilike.${p},brand_name.ilike.${p}`);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    const rows = data || [];
    const hasMore = rows.length > lim;
    const brandItems = hasMore ? rows.slice(0, lim) : rows;

    if (!brandItems.length) {
        return res.json({ success: true, level: "brand_item", items: [], hasMore, nextOffset: off + brandItems.length });
    }

    const ids = brandItems.map((b) => b.id);
    const { data: listings, error: listErr } = await supabase
        .from("seller_product_submissions")
        .select("generic_product_brand_id, price")
        .in("generic_product_brand_id", ids)
        .eq("review_status", "approved")
        .eq("is_active", true);
    if (listErr) return res.status(500).json({ success: false, message: listErr.message });

    const statsByBrand = {};
    for (const row of listings || []) {
        const s = statsByBrand[row.generic_product_brand_id] || { count: 0, lowest: null };
        s.count += 1;
        const price = Number(row.price);
        if (s.lowest === null || price < s.lowest) s.lowest = price;
        statsByBrand[row.generic_product_brand_id] = s;
    }

    const items = brandItems.map((b) => ({
        ...b,
        sellerCount: statsByBrand[b.id]?.count || 0,
        lowestPrice: statsByBrand[b.id]?.lowest ?? null,
    }));

    res.json({ success: true, level: "brand_item", items, hasMore, nextOffset: off + items.length });
}

// GET /api/catalog-search/sellers?brandItemId=&q=&limit=&offset=
export async function searchSellersForBrandItemV2(req, res) {
    const { brandItemId, q = "", limit, offset } = req.query;
    if (!brandItemId) return res.status(400).json({ success: false, message: "brandItemId is required." });
    const lim = clampLimit(limit);
    const off = clampOffset(offset);

    let query = supabase
        .from("seller_product_submissions")
        .select(`
            id, price, moq, unit, lead_time, image,
            seller:seller_profiles!inner (id, shop_slug, display_name, logo_url, city, state, business_type)
        `)
        .eq("generic_product_brand_id", brandItemId)
        .eq("review_status", "approved")
        .eq("is_active", true)
        .order("price", { ascending: true })
        .range(off, off + lim);
    if (q.trim()) query = query.ilike("seller.display_name", ilikePattern(q.trim()));
    if (req.sellerId) query = query.neq("seller_id", req.sellerId);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    const rows = data || [];
    const hasMore = rows.length > lim;
    const sliced = hasMore ? rows.slice(0, lim) : rows;

    const items = sliced.map((row) => ({
        offerId: row.id,
        price: row.price,
        unit: row.unit,
        moq: row.moq,
        leadTime: row.lead_time,
        image: row.image,
        ...row.seller,
    }));

    res.json({ success: true, level: "seller", items, hasMore, nextOffset: off + items.length });
}

// GET /api/catalog-search/hierarchy?level=&parentId=&q=&limit=&offset=
// Single convenience endpoint, mirrors the existing searchHierarchy dispatcher.
// No changes needed beyond the endpoints above — it just forwards
// req.query, so `offset` passes straight through automatically.
export async function searchHierarchyV2(req, res) {
    const { level, parentId } = req.query;
    switch (level) {
        case "category":
            return searchCategoriesV2(req, res);
        case "subcategory":
            req.query.categoryId = parentId;
            return searchSubcategoriesV2(req, res);
        case "generic_product":
            req.query.subcategoryId = parentId;
            return searchGenericProductsV2(req, res);
        case "brand_item":
            req.query.genericProductId = parentId;
            return searchBrandItemsV2(req, res);
        case "seller":
            req.query.brandItemId = parentId;
            return searchSellersForBrandItemV2(req, res);
        default:
            return res.status(400).json({ success: false, message: "level must be one of category|subcategory|generic_product|brand_item|seller" });
    }
}

// GET /api/catalog-search/smart?q=&limit=
// Cross-level fallback — used when a scoped search at the buyer's current
// level comes up empty, same purpose as the existing smartSearch, but
// scoped entirely to the new approved-only hierarchy. No AI involved,
// no rejectedExact concept (there's no AI-resolve step downstream of this
// page to gate). Left un-paginated on purpose — this is a small typeahead
// fallback (cap 5-10), not a browsable list.
export async function smartSearchV2(req, res) {
    const { q = "", limit } = req.query;
    const term = q.trim();
    if (term.length < 2) {
        return res.json({ success: true, exact: null, suggestions: { categories: [], subcategories: [], genericProducts: [], brandItems: [] } });
    }
    const cap = clampLimit(limit) > 10 ? 5 : clampLimit(limit);
    const pattern = ilikePattern(term);
    const orPattern = orIlikePattern(term);

    const [catRes, subRes, gpRes, biRes] = await Promise.all([
        supabase.from("hs_categories").select("id, name, slug, image").eq("review_status", "approved").ilike("name", pattern).limit(cap),
        supabase.from("hs_subcategories").select("id, name, slug, image, category_id, category:hs_categories(id, name, slug)").eq("review_status", "approved").ilike("name", pattern).limit(cap),
        supabase.from("hs_generic_products").select("id, name, slug, image, subcategory_id, subcategory:hs_subcategories(id, name, slug, category_id, category:hs_categories(id, name, slug))").eq("review_status", "approved").ilike("name", pattern).limit(cap),
        supabase.from("hs_generic_product_brands").select(`
            id, name, brand_name, slug, image, images, generic_product_id,
            generic_product:hs_generic_products(id, name, slug, subcategory_id,
                subcategory:hs_subcategories(id, name, slug, category_id,
                    category:hs_categories(id, name, slug)))
        `).eq("review_status", "approved").or(`name.ilike.${orPattern},brand_name.ilike.${orPattern}`).limit(cap),
    ]);

    if (catRes.error) return res.status(500).json({ success: false, message: catRes.error.message });
    if (subRes.error) return res.status(500).json({ success: false, message: subRes.error.message });
    if (gpRes.error) return res.status(500).json({ success: false, message: gpRes.error.message });
    if (biRes.error) return res.status(500).json({ success: false, message: biRes.error.message });

    const categories = catRes.data || [];
    const subcategories = subRes.data || [];
    const genericProducts = gpRes.data || [];
    const brandItems = biRes.data || [];

    const isExact = (name) => (name || "").toLowerCase() === term.toLowerCase();

    const exactBrandItem = brandItems.find((b) => isExact(b.name) || isExact(b.brand_name));
    const exactGeneric = genericProducts.find((g) => isExact(g.name));
    const exactSub = subcategories.find((s) => isExact(s.name));
    const exactCat = categories.find((c) => isExact(c.name));

    let exact = null;
    if (exactBrandItem) {
        const gp = exactBrandItem.generic_product;
        const sc = gp?.subcategory;
        const c = sc?.category;
        exact = {
            type: "brand_item",
            stack: [
                c && { level: "category", id: c.id, name: c.name },
                sc && { level: "subcategory", id: sc.id, name: sc.name },
                gp && { level: "generic_product", id: gp.id, name: gp.name },
                {
                    level: "brand_item",
                    id: exactBrandItem.id,
                    name: exactBrandItem.name,
                    image: exactBrandItem.image,
                    images: exactBrandItem.images,
                    brand_name: exactBrandItem.brand_name,
                },
            ].filter(Boolean),
        };
    } else if (exactGeneric) {
        const sc = exactGeneric.subcategory;
        const c = sc?.category;
        exact = {
            type: "generic_product",
            stack: [
                c && { level: "category", id: c.id, name: c.name },
                sc && { level: "subcategory", id: sc.id, name: sc.name },
                { level: "generic_product", id: exactGeneric.id, name: exactGeneric.name },
            ].filter(Boolean),
        };
    } else if (exactSub) {
        const c = exactSub.category;
        exact = {
            type: "subcategory",
            stack: [
                c && { level: "category", id: c.id, name: c.name },
                { level: "subcategory", id: exactSub.id, name: exactSub.name },
            ].filter(Boolean),
        };
    } else if (exactCat) {
        exact = { type: "category", stack: [{ level: "category", id: exactCat.id, name: exactCat.name }] };
    }

    res.json({
        success: true,
        exact,
        suggestions: {
            categories: categories.map((c) => ({ id: c.id, name: c.name, image: c.image, level: "category" })),
            subcategories: subcategories.map((s) => ({
                id: s.id, name: s.name, image: s.image, level: "subcategory",
                categoryId: s.category?.id, categoryName: s.category?.name,
            })),
            genericProducts: genericProducts.map((g) => ({
                id: g.id, name: g.name, image: g.image, level: "generic_product",
                subcategoryId: g.subcategory?.id, subcategoryName: g.subcategory?.name,
                categoryId: g.subcategory?.category?.id, categoryName: g.subcategory?.category?.name,
            })),
            brandItems: brandItems.map((b) => {
                const gp = b.generic_product;
                const sc = gp?.subcategory;
                const c = sc?.category;
                return {
                    id: b.id, name: b.name, brandName: b.brand_name, image: b.image, level: "brand_item",
                    genericProductId: gp?.id, genericProductName: gp?.name,
                    subcategoryId: sc?.id, subcategoryName: sc?.name,
                    categoryId: c?.id, categoryName: c?.name,
                };
            }),
        },
    });
}

// GET /api/catalog-search/autocomplete?q=&limit=
// Left un-paginated on purpose — this is a small typeahead dropdown
// (cap 8-10 total across all levels), not a browsable list.
export async function searchAutocompleteV2(req, res) {
    const { q = "", limit } = req.query;
    const term = q.trim();
    if (term.length < 2) return res.json({ success: true, suggestions: [] });

    const cap = Math.min(Number(limit) || 8, 10);
    const perTable = 4;
    const pattern = ilikePattern(term);
    const orPattern = orIlikePattern(term);

    const [catRes, subRes, gpRes, biRes] = await Promise.all([
        supabase.from("hs_categories").select("id, name, slug").eq("review_status", "approved").ilike("name", pattern).order("name").limit(perTable),
        supabase.from("hs_subcategories").select("id, name, slug").eq("review_status", "approved").ilike("name", pattern).order("name").limit(perTable),
        supabase.from("hs_generic_products").select("id, name, slug").eq("review_status", "approved").ilike("name", pattern).order("name").limit(perTable),
        supabase.from("hs_generic_product_brands").select("id, name, brand_name, slug").eq("review_status", "approved").or(`name.ilike.${orPattern},brand_name.ilike.${orPattern}`).order("name").limit(perTable),
    ]);

    if (catRes.error || subRes.error || gpRes.error || biRes.error) {
        return res.json({ success: true, suggestions: [] });
    }

    const raw = [
        ...(catRes.data || []).map((c) => ({ id: c.id, name: c.name, level: "category" })),
        ...(subRes.data || []).map((s) => ({ id: s.id, name: s.name, level: "subcategory" })),
        ...(gpRes.data || []).map((g) => ({ id: g.id, name: g.name, level: "generic_product" })),
        ...(biRes.data || []).map((b) => ({ id: b.id, name: b.name, brandName: b.brand_name, level: "brand_item" })),
    ];

    const lowerTerm = term.toLowerCase();
    const rank = (s) => {
        const n = s.name.toLowerCase();
        if (n.startsWith(lowerTerm)) return 0;
        if (n.includes(` ${lowerTerm}`)) return 1;
        return 2;
    };
    raw.sort((a, b) => rank(a) - rank(b));

    const seen = new Set();
    const deduped = [];
    for (const s of raw) {
        const key = `${s.level}:${s.name.trim().toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(s);
        if (deduped.length >= cap) break;
    }

    res.json({ success: true, suggestions: deduped });
}

// GET /api/catalog-search/products-fallback?q=&limit=&offset=
// Tiered product search for the results page: tries a direct product
// (brand item) match first. If nothing matches at that level, widens to
// sibling products under a matching SUBCATEGORY name. If that's also
// empty, widens further to every product under a matching CATEGORY
// name. Always responds 200 with `matchLevel` telling the frontend which
// tier produced the results ("product" | "subcategory" | "category" |
// "none") — the page stays put and shows "results from <matchedOn>"
// instead of ever having a reason to navigate elsewhere, even on zero
// results.
// GET /api/catalog-search/products-merged?q=&limit=&offset=
// Single merged, tiered result: direct product/brand-name matches first,
// then products under a matching subcategory (excluding anything already
// listed), then products under a matching category (excluding tiers 1+2).
// Always runs all three tiers and concatenates — no "try product first,
// only widen if empty" branching.
//
// CAVEAT: pagination across tiers is approximate, not a single true
// cross-tier offset query. Each tier is fetched up to `offset + limit + 1`
// rows, concatenated in priority order, then sliced to the requested
// page. This is exact for page 1 and close enough for typical scrolling,
// but a very deep offset that straddles a tier boundary can shift
// slightly — flagging this rather than presenting it as precise.
export async function searchProductsMergedV2(req, res) {
    const { q = "", limit, offset } = req.query;
    const term = q.trim();
    const lim = clampLimit(limit);
    const off = clampOffset(offset);

    if (!term) {
        return res.json({ success: true, items: [], hasMore: false, nextOffset: 0 });
    }

    const pattern = ilikePattern(term);
    const orPattern = orIlikePattern(term);
    const fetchCap = off + lim + 1;

    // Every tier selects the same hierarchy join so category_name /
    // subcategory_name reach the frontend exactly like the normal feed —
    // ProductRow otherwise renders that line blank for search results.
    const BRAND_ITEM_SELECT = `
    id, generic_product_id, name, brand_name, slug, image, images, brand_image,
    generic_product:hs_generic_products (
        name,
        subcategory:hs_subcategories ( name,
            category:hs_categories ( name )
        )
    )
`;

    const seenIds = new Set();
    const tiered = [];

    // Tier 1 — direct product/brand-name match.
    const { data: directRows, error: directErr } = await supabase
        .from("hs_generic_product_brands")
        .select(BRAND_ITEM_SELECT)
        .eq("review_status", "approved")
        .or(`name.ilike.${orPattern},brand_name.ilike.${orPattern}`)
        .order("name")
        .limit(fetchCap);
    if (directErr) return res.status(500).json({ success: false, message: directErr.message });

    for (const row of directRows || []) {
        if (seenIds.has(row.id)) continue;
        seenIds.add(row.id);
        tiered.push({ ...row, matchTier: "product" });
    }

    // Tier 2 — products under a matching subcategory.
    if (tiered.length < fetchCap) {
        const { data: subMatches, error: subErr } = await supabase
            .from("hs_subcategories")
            .select("id, name")
            .eq("review_status", "approved")
            .ilike("name", pattern)
            .limit(1);
        if (subErr) return res.status(500).json({ success: false, message: subErr.message });

        if (subMatches?.length) {
            const sub = subMatches[0];
            const { data: gpRows, error: gpErr } = await supabase
                .from("hs_generic_products")
                .select("id")
                .eq("subcategory_id", sub.id)
                .eq("review_status", "approved");
            if (gpErr) return res.status(500).json({ success: false, message: gpErr.message });

            const gpIds = (gpRows || []).map((g) => g.id);
            if (gpIds.length) {
                const { data: subItems, error: subItemsErr } = await supabase
                    .from("hs_generic_product_brands")
                    .select(BRAND_ITEM_SELECT)
                    .in("generic_product_id", gpIds)
                    .eq("review_status", "approved")
                    .order("name")
                    .limit(fetchCap);
                if (subItemsErr) return res.status(500).json({ success: false, message: subItemsErr.message });

                for (const row of subItems || []) {
                    if (seenIds.has(row.id)) continue;
                    seenIds.add(row.id);
                    tiered.push({ ...row, matchTier: "subcategory" });
                }
            }
        }
    }

    // Tier 3 — products under a matching category.
    if (tiered.length < fetchCap) {
        const { data: catMatches, error: catErr } = await supabase
            .from("hs_categories")
            .select("id, name")
            .eq("review_status", "approved")
            .ilike("name", pattern)
            .limit(1);
        if (catErr) return res.status(500).json({ success: false, message: catErr.message });

        if (catMatches?.length) {
            const cat = catMatches[0];
            const { data: subIdRows, error: subIdErr } = await supabase
                .from("hs_subcategories")
                .select("id")
                .eq("category_id", cat.id)
                .eq("review_status", "approved");
            if (subIdErr) return res.status(500).json({ success: false, message: subIdErr.message });

            const subcategoryIds = (subIdRows || []).map((s) => s.id);
            if (subcategoryIds.length) {
                const { data: gpRows2, error: gpErr2 } = await supabase
                    .from("hs_generic_products")
                    .select("id")
                    .in("subcategory_id", subcategoryIds)
                    .eq("review_status", "approved");
                if (gpErr2) return res.status(500).json({ success: false, message: gpErr2.message });

                const gpIds2 = (gpRows2 || []).map((g) => g.id);
                if (gpIds2.length) {
                    const { data: catItems, error: catItemsErr } = await supabase
                        .from("hs_generic_product_brands")
                        .select(BRAND_ITEM_SELECT)
                        .in("generic_product_id", gpIds2)
                        .eq("review_status", "approved")
                        .order("name")
                        .limit(fetchCap);
                    if (catItemsErr) return res.status(500).json({ success: false, message: catItemsErr.message });

                    for (const row of catItems || []) {
                        if (seenIds.has(row.id)) continue;
                        seenIds.add(row.id);
                        tiered.push({ ...row, matchTier: "category" });
                    }
                }
            }
        }
    }

    const page = tiered.slice(off, off + lim);
    const hasMore = tiered.length > off + lim;

    if (!page.length) {
        return res.json({ success: true, items: [], hasMore: false, nextOffset: off });
    }

    const ids = page.map((b) => b.id);
    const { data: listings, error: listErr } = await supabase
        .from("seller_product_submissions")
        .select("generic_product_brand_id, price, unit, pack_size, units_per_master_pack, gst_percent, stock_type, stock_quantity")
        .in("generic_product_brand_id", ids)
        .eq("review_status", "approved")
        .eq("is_active", true);
    if (listErr) return res.status(500).json({ success: false, message: listErr.message });

    const lowestByBrand = {};
    for (const row of listings || []) {
        const current = lowestByBrand[row.generic_product_brand_id];
        if (!current || Number(row.price) < Number(current.price)) {
            lowestByBrand[row.generic_product_brand_id] = row;
        }
    }

    // Flatten the nested join into the same flat field names ProductRow
    // already expects from the normal feed (category_name/subcategory_name),
    // and drop the raw nested `generic_product` object from the response.
    const items = page.map((b) => {
        const l = lowestByBrand[b.id];
        const gp = b.generic_product;
        const sc = gp?.subcategory;
        const cat = sc?.category;
        const { generic_product, ...rest } = b;
        return {
            ...rest, // includes brand_image now that it's selected
            category_name: cat?.name ?? null,
            subcategory_name: sc?.name ?? null,
            lowest_price: l?.price ?? null,
            lowest_price_unit: l?.unit ?? null,
            lowest_price_pack_size: l?.pack_size ?? null,
            lowest_price_master_pack_size: l?.units_per_master_pack ?? null,
            lowest_price_gst_percent: l?.gst_percent ?? null,
            lowest_price_stock_type: l?.stock_type ?? null,
            lowest_price_available_stock: l?.stock_quantity ?? null,
        };
    });

    res.json({ success: true, items, hasMore, nextOffset: off + items.length });
}