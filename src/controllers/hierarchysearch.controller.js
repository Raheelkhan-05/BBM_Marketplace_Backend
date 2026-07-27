import { supabase } from "../config/supabase.js";

// All four handlers follow the same shape: { success, items }
// so the frontend can treat every level of the hierarchy identically.

const DEFAULT_LIMIT = 20;

function clampLimit(limit) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
    return Math.min(n, 50);
}

// GET /api/search/categories?q=bearing&limit=20
export async function searchCategories(req, res) {
    const { q = "", limit } = req.query;

    let query = supabase
        .from("hs_categories")
        .select("id, name, slug, image")
        .order("name")
        .limit(clampLimit(limit));

    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, level: "category", items: data || [] });
}

// GET /api/search/subcategories?categoryId=...&q=deep&limit=20
export async function searchSubcategories(req, res) {
    const { categoryId, q = "", limit } = req.query;
    if (!categoryId) return res.status(400).json({ success: false, message: "categoryId is required." });

    let query = supabase
        .from("hs_subcategories")
        .select("id, category_id, name, slug, image")
        .eq("category_id", categoryId)
        .order("name")
        .limit(clampLimit(limit));

    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, level: "subcategory", items: data || [] });
}

// GET /api/search/products?subcategoryId=...&q=skf&limit=20
export async function searchProducts(req, res) {
    const { subcategoryId, q = "", limit } = req.query;
    if (!subcategoryId) return res.status(400).json({ success: false, message: "subcategoryId is required." });

    let query = supabase
        .from("hs_products")
        .select("id, subcategory_id, name, slug, image, description")
        .eq("subcategory_id", subcategoryId)
        .order("name")
        .limit(clampLimit(limit));

    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, level: "product", items: data || [] });
}

// GET /api/search/sellers?productId=...&q=national&limit=20
// Joins hs_product_sellers -> seller_profiles in a single round trip.
export async function searchSellersForProduct(req, res) {
    const { productId, q = "", limit } = req.query;
    if (!productId) return res.status(400).json({ success: false, message: "productId is required." });

    let query = supabase
        .from("hs_product_sellers")
        .select(`
      id,
      price,
      unit,
      moq,
      delivery_days,
      seller:seller_profiles!inner (
        id, shop_slug, display_name, logo_url, city, state, business_type
      )
    `)
        .eq("product_id", productId)
        .eq("is_active", true)
        .order("price", { ascending: true })
        .limit(clampLimit(limit));

    if (q.trim()) query = query.ilike("seller.display_name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    const items = (data || []).map((row) => ({
        offerId: row.id,
        price: row.price,
        unit: row.unit,
        moq: row.moq,
        deliveryDays: row.delivery_days,
        ...row.seller,
    }));

    res.json({ success: true, level: "seller", items });
}

// GET /api/search/smart?q=bearing&limit=5
// Searches across ALL levels at once (unlike the level-scoped endpoints above).
// Used as a fallback when a scoped search at the user's current level comes
// up empty — e.g. user is browsing "Bearings" but types a lubricant's name.
//
// Returns:
//   exact       — a single confident exact-name match (deepest level wins),
//                 with the full breadcrumb `stack` needed to jump straight
//                 to it (frontend lands one level below the match).
//   suggestions — partial matches per level, each carrying enough ancestor
//                 info for the frontend to build a jump stack if tapped.
export async function smartSearch(req, res) {
    const { q = "", limit } = req.query;
    const term = q.trim();
    if (term.length < 2) {
        return res.json({ success: true, exact: null, suggestions: { categories: [], subcategories: [], products: [] } });
    }
    const cap = clampLimit(limit) > 10 ? 5 : clampLimit(limit);

    const [catRes, subRes, prodRes] = await Promise.all([
        supabase.from("hs_categories").select("id, name, slug, image").ilike("name", `%${term}%`).limit(cap),
        supabase
            .from("hs_subcategories")
            .select("id, name, slug, image, category_id, category:hs_categories(id, name, slug)")
            .ilike("name", `%${term}%`)
            .limit(cap),
        supabase
            .from("hs_products")
            .select("id, name, slug, image, subcategory_id, subcategory:hs_subcategories(id, name, slug, category_id, category:hs_categories(id, name, slug))")
            .ilike("name", `%${term}%`)
            .limit(cap),
    ]);

    if (catRes.error) return res.status(500).json({ success: false, message: catRes.error.message });
    if (subRes.error) return res.status(500).json({ success: false, message: subRes.error.message });
    if (prodRes.error) return res.status(500).json({ success: false, message: prodRes.error.message });

    const categories = catRes.data || [];
    const subcategories = subRes.data || [];
    const products = prodRes.data || [];

    const isExact = (name) => name.toLowerCase() === term.toLowerCase();

    // Deepest exact match wins (product > subcategory > category) since it's
    // the most specific thing the user could have typed.
    const exactProduct = products.find((p) => isExact(p.name));
    const exactSubcategory = subcategories.find((s) => isExact(s.name));
    const exactCategory = categories.find((c) => isExact(c.name));

    let exact = null;
    if (exactProduct) {
        const sc = exactProduct.subcategory;
        const c = sc?.category;
        exact = {
            type: "product",
            stack: [
                c && { level: "category", id: c.id, name: c.name },
                sc && { level: "subcategory", id: sc.id, name: sc.name },
                { level: "product", id: exactProduct.id, name: exactProduct.name },
            ].filter(Boolean),
        };
    } else if (exactSubcategory) {
        const c = exactSubcategory.category;
        exact = {
            type: "subcategory",
            stack: [
                c && { level: "category", id: c.id, name: c.name },
                { level: "subcategory", id: exactSubcategory.id, name: exactSubcategory.name },
            ].filter(Boolean),
        };
    } else if (exactCategory) {
        exact = { type: "category", stack: [{ level: "category", id: exactCategory.id, name: exactCategory.name }] };
    }

    res.json({
        success: true,
        exact,
        suggestions: {
            categories: categories.map((c) => ({ id: c.id, name: c.name, image: c.image, subtitle: null })),
            subcategories: subcategories.map((s) => ({
                id: s.id,
                name: s.name,
                image: s.image,
                categoryId: s.category?.id,
                categoryName: s.category?.name,
                subtitle: s.category ? `in ${s.category.name}` : null,
            })),
            products: products.map((p) => ({
                id: p.id,
                name: p.name,
                image: p.image,
                subcategoryId: p.subcategory?.id,
                subcategoryName: p.subcategory?.name,
                categoryId: p.subcategory?.category?.id,
                categoryName: p.subcategory?.category?.name,
                subtitle:
                    p.subcategory?.category && p.subcategory
                        ? `in ${p.subcategory.category.name} > ${p.subcategory.name}`
                        : null,
            })),
        },
    });
}

// GET /api/search/hierarchy?level=category|subcategory|product|seller&parentId=...&q=...
// Single convenience endpoint the frontend hook can call without branching
// on which level-specific route to hit.
export async function searchHierarchy(req, res) {
    const { level } = req.query;
    switch (level) {
        case "category":
            return searchCategories(req, res);
        case "subcategory":
            return searchSubcategories(req, res);
        case "product":
            return searchProducts(req, res);
        case "seller":
            return searchSellersForProduct(req, res);
        default:
            return res.status(400).json({ success: false, message: "level must be one of category|subcategory|product|seller" });
    }
}