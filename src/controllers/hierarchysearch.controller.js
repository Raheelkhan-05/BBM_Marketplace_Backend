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
// GET /api/search/categories?q=bearing&limit=20
// CHANGED: only returns categories that actually have at least one
// approved brand item listed somewhere beneath them (category ->
// subcategory -> product -> brand). Previously any category with
// review_status !== "rejected" was returned, even if it was empty all
// the way down — which meant the Home Page CategoryStrip could show a
// tappable category with nothing to show once selected. The !inner
// joins below make Postgres only return a category row when a matching
// chain of children exists; the eq() filter on the nested brand's
// review_status keeps it to *approved* items specifically (not just
// non-rejected), since a pending_review brand item isn't buyable yet
// either.
// GET /api/search/categories?q=bearing
// FIXED (final): dropped the seller/wallet-eligibility requirement
// entirely. Confirmed against real data — e.g. "Shell R4 15W40" is
// approved+active+sellable but has generic_product_id = null (unmapped,
// so it can't belong to any category), while "Yonex Nanoflare" IS mapped
// to Sports & Fitness but both its submissions are rejected/inactive —
// yet it still shows up in the product listing page (with blank
// pricing), because that page's own query (catalog_browse) LEFT JOINs
// seller submissions rather than requiring one. A category should
// appear here under the same rule the listing page uses: it has at
// least one approved, non-deleted brand item that resolves to it
// through generic_product -> subcategory -> category, regardless of
// whether anyone is currently selling it.
export async function searchCategories(req, res) {
    const { q = "" } = req.query;

    const { data: brands, error: brandErr } = await supabase
        .from("hs_generic_product_brands")
        .select(`
            id,
            generic_product:hs_generic_products (
                id, subcategory_id, deleted_at,
                subcategory:hs_subcategories (
                    id, category_id, deleted_at
                )
            )
        `)
        .eq("review_status", "approved")
        .is("deleted_at", null)
        .not("generic_product_id", "is", null);

    if (brandErr) return res.status(500).json({ success: false, message: brandErr.message });

    const categoryIds = [...new Set(
        (brands || [])
            .filter((b) => b.generic_product && !b.generic_product.deleted_at
                && b.generic_product.subcategory && !b.generic_product.subcategory.deleted_at)
            .map((b) => b.generic_product.subcategory.category_id)
            .filter(Boolean)
    )];

    if (!categoryIds.length) {
        return res.json({ success: true, level: "category", items: [] });
    }

    let query = supabase
        .from("hs_categories")
        .select("id, name, slug, image")
        .in("id", categoryIds)
        .is("deleted_at", null)
        .order("name");

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
        .neq("review_status", "rejected")
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
        .neq("review_status", "rejected")
        .order("name")
        .limit(clampLimit(limit));

    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, level: "product", items: data || [] });
}

// GET /api/search/brands?productId=...&q=castrol&limit=20
export async function searchBrands(req, res) {
    const { productId, q = "", limit } = req.query;
    if (!productId) return res.status(400).json({ success: false, message: "productId is required." });

    let query = supabase
        .from("hs_product_brands")
        .select("id, product_id, name, brand_name, slug, image, description, attributes")
        .eq("product_id", productId)
        .neq("review_status", "rejected")
        .order("name")
        .limit(clampLimit(limit));

    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, level: "brand", items: data || [] });
}

// GET /api/search/sellers?productId=...&q=national&limit=20
// Joins hs_product_sellers -> seller_profiles in a single round trip.
export async function searchSellersForProduct(req, res) {
    const { productId, brandId, q = "", limit } = req.query;
    if (!productId) return res.status(400).json({ success: false, message: "productId is required." });

    let query = supabase
        .from("hs_product_sellers")
        .select(`
      id,
      price,
      unit,
      moq,
      delivery_days,
      brand_id,
      seller:seller_profiles!inner (
        id, shop_slug, display_name, logo_url, city, state, business_type
      )
    `)
        .eq("product_id", productId)
        .eq("is_active", true)
        .order("price", { ascending: true })
        .limit(clampLimit(limit));

    if (brandId) query = query.eq("brand_id", brandId);
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
        return res.json({ success: true, exact: null, rejectedExact: null, suggestions: { categories: [], subcategories: [], products: [] } });
    }
    const cap = clampLimit(limit) > 10 ? 5 : clampLimit(limit);

    // NOTE: review_status is now selected (not filtered at the query level)
    // so we can separate "active, show as suggestion" from "rejected,
    // exact-match-only, tells the caller not to bother the AI" ourselves.
    const [catRes, subRes, prodRes, brandRes] = await Promise.all([
        supabase.from("hs_categories").select("id, name, slug, image, review_status").ilike("name", `%${term}%`).limit(cap * 3),
        supabase.from("hs_subcategories").select("id, name, slug, image, category_id, review_status, category:hs_categories(id, name, slug)").ilike("name", `%${term}%`).limit(cap * 3),
        supabase.from("hs_products").select("id, name, slug, image, subcategory_id, review_status, subcategory:hs_subcategories(id, name, slug, category_id, category:hs_categories(id, name, slug))").ilike("name", `%${term}%`).limit(cap * 3),
        supabase.from("hs_product_brands").select(`
        id, name, brand_name, slug, image, product_id, review_status,
        product:hs_products(id, name, slug, subcategory_id,
            subcategory:hs_subcategories(id, name, slug, category_id,
                category:hs_categories(id, name, slug)))
    `).or(`name.ilike.%${term}%,brand_name.ilike.%${term}%`).limit(cap * 3),
    ]);

    if (catRes.error) return res.status(500).json({ success: false, message: catRes.error.message });
    if (subRes.error) return res.status(500).json({ success: false, message: subRes.error.message });
    if (prodRes.error) return res.status(500).json({ success: false, message: prodRes.error.message });
    if (brandRes.error) return res.status(500).json({ success: false, message: brandRes.error.message });

    const allCategories = catRes.data || [];
    const allSubcategories = subRes.data || [];
    const allProducts = prodRes.data || [];
    const allBrands = brandRes.data || [];

    const isExact = (name) => name.toLowerCase() === term.toLowerCase();

    // Only rejected rows matter for the "don't call the AI" check — an exact
    // rejected match means this term was already reviewed and declined.
    const rejectedExactBrand = allBrands.find((b) => b.review_status === "rejected" && isExact(b.name));
    const rejectedExactProduct = allProducts.find((p) => p.review_status === "rejected" && isExact(p.name));
    const rejectedExactSubcategory = allSubcategories.find((s) => s.review_status === "rejected" && isExact(s.name));
    const rejectedExactCategory = allCategories.find((c) => c.review_status === "rejected" && isExact(c.name));

    let rejectedExact = null;
    if (rejectedExactBrand) rejectedExact = { level: "brand", name: rejectedExactBrand.name };
    else if (rejectedExactProduct) rejectedExact = { level: "product", name: rejectedExactProduct.name };
    else if (rejectedExactSubcategory) rejectedExact = { level: "subcategory", name: rejectedExactSubcategory.name };
    else if (rejectedExactCategory) rejectedExact = { level: "category", name: rejectedExactCategory.name };

    // Everything below this line — suggestions and the "exact" match used to
    // jump straight to a page — only ever considers active (non-rejected) rows,
    // same as before.
    const categories = allCategories.filter((c) => c.review_status !== "rejected").slice(0, cap);
    const subcategories = allSubcategories.filter((s) => s.review_status !== "rejected").slice(0, cap);
    const products = allProducts.filter((p) => p.review_status !== "rejected").slice(0, cap);
    const brands = allBrands.filter((b) => b.review_status !== "rejected").slice(0, cap);

    const exactBrand = brands.find((b) => isExact(b.name));
    const exactProduct = products.find((p) => isExact(p.name));
    const exactSubcategory = subcategories.find((s) => isExact(s.name));
    const exactCategory = categories.find((c) => isExact(c.name));

    let exact = null;
    if (exactBrand) {
        const p = exactBrand.product;
        const sc = p?.subcategory;
        const c = sc?.category;
        exact = {
            type: "brand",
            stack: [
                c && { level: "category", id: c.id, name: c.name },
                sc && { level: "subcategory", id: sc.id, name: sc.name },
                p && { level: "product", id: p.id, name: p.name },
                { level: "brand", id: exactBrand.id, name: exactBrand.name },
            ].filter(Boolean),
        };
    } else if (exactProduct) {
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
        rejectedExact, // frontend/AI-resolve should treat this as "stop, don't call the AI"
        suggestions: {
            categories: categories.map((c) => ({ id: c.id, name: c.name, image: c.image, subtitle: null })),
            subcategories: subcategories.map((s) => ({
                id: s.id, name: s.name, image: s.image,
                categoryId: s.category?.id, categoryName: s.category?.name,
                subtitle: s.category ? `in ${s.category.name}` : null,
            })),
            products: products.map((p) => ({
                id: p.id, name: p.name, image: p.image,
                subcategoryId: p.subcategory?.id, subcategoryName: p.subcategory?.name,
                categoryId: p.subcategory?.category?.id, categoryName: p.subcategory?.category?.name,
                subtitle: p.subcategory?.category && p.subcategory ? `in ${p.subcategory.category.name} > ${p.subcategory.name}` : null,
            })),
            brands: brands.map((b) => {
                const p = b.product;
                const sc = p?.subcategory;
                const c = sc?.category;
                return {
                    id: b.id, name: b.name, brandName: b.brand_name, image: b.image,
                    productId: p?.id, productName: p?.name,
                    subcategoryId: sc?.id, subcategoryName: sc?.name,
                    categoryId: c?.id, categoryName: c?.name,
                    subtitle: c && sc && p ? `in ${c.name} > ${sc.name} > ${p.name}` : null,
                };
            }),
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
        case "brand":
            return searchBrands(req, res);
        case "seller":
            return searchSellersForProduct(req, res);
        default:
            return res.status(400).json({ success: false, message: "level must be one of category|subcategory|product|brand|seller" });
    }
}

// backend/controllers/hierarchysearch.controller.js  (add this function)

// GET /api/search/autocomplete?q=bea&limit=8
// Pure DB pattern-match typeahead — NO AI involved. Optimized for speed:
// small per-table limits, pattern match (name ILIKE 'term%') prioritized
// over "contains" so relevant results surface first, like Google's typeahead.
export async function searchAutocomplete(req, res) {
    const { q = "", limit } = req.query;
    const term = q.trim();

    if (term.length < 2) {
        return res.json({ success: true, suggestions: [] });
    }

    const cap = Math.min(Number(limit) || 8, 10);
    const perTable = 4;
    const pattern = `%${term}%`;

    const [catRes, subRes, prodRes, brandRes, brandFamilyRes] = await Promise.all([
        supabase.from("hs_categories").select("id, name, slug").neq("review_status", "rejected").ilike("name", pattern).order("name").limit(perTable),
        supabase.from("hs_subcategories").select("id, name, slug").neq("review_status", "rejected").ilike("name", pattern).order("name").limit(perTable),
        supabase.from("hs_products").select("id, name, slug").neq("review_status", "rejected").ilike("name", pattern).order("name").limit(perTable),
        supabase.from("hs_product_brands").select("id, name, brand_name, slug").neq("review_status", "rejected").or(`name.ilike.${pattern},brand_name.ilike.${pattern}`).order("name").limit(perTable),
        // NEW: dedicated lookup so a brand FAMILY (e.g. "Yogi Hi-Tech") gets its
        // own suggestion row, separate from any individual SKU it makes.
        // Only need brand_name here — dedup happens in JS below.
        supabase.from("hs_product_brands").select("brand_name").neq("review_status", "rejected").not("brand_name", "is", null).ilike("brand_name", pattern).limit(30),
    ]);

    if (catRes.error || subRes.error || prodRes.error || brandRes.error || brandFamilyRes.error) {
        return res.json({ success: true, suggestions: [] });
    }

    // Collapse to unique brand_name values, then keep just a couple —
    // this is a suggestion category, not a results list.
    const uniqueBrandFamilies = [...new Set((brandFamilyRes.data || []).map((r) => r.brand_name).filter(Boolean))].slice(0, 3);

    const raw = [
        ...(catRes.data || []).map((c) => ({ id: c.id, name: c.name, level: "category" })),
        ...(subRes.data || []).map((s) => ({ id: s.id, name: s.name, level: "subcategory" })),
        ...(prodRes.data || []).map((p) => ({ id: p.id, name: p.name, level: "product" })),
        ...(brandRes.data || []).map((b) => ({ id: b.id, name: b.name, brandName: b.brand_name, level: "brand" })),
        // NEW: brand-family suggestions, ranked and deduped alongside everything else
        ...uniqueBrandFamilies.map((name) => ({ id: `brand-family:${name}`, name, level: "brandFamily" })),
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

// GET /api/search/brand-family?brandName=Castrol&limit=50
// Reverse lookup: given a brand name, find every product (and its
// subcategory/category ancestry) that carries that brand — i.e. the
// full "family" of places this brand shows up across the catalog.
export async function searchBrandFamily(req, res) {
    const { brandName, limit } = req.query;
    if (!brandName || !brandName.trim()) {
        return res.status(400).json({ success: false, message: "brandName is required." });
    }
    const term = brandName.trim();

    const { data, error } = await supabase
        .from("hs_product_brands")
        .select(`
      id, name, brand_name, slug, image, description, attributes, product_id,
      product:hs_products (
        id, name, slug,
        subcategory:hs_subcategories (
          id, name, slug,
          category:hs_categories ( id, name, slug )
        )
      )
    `)
        .or(`brand_name.ilike.%${term}%,name.ilike.%${term}%`)
        .neq("review_status", "rejected")
        .order("name")
        .limit(clampLimit(limit));

    if (error) return res.status(500).json({ success: false, message: error.message });

    const rows = data || [];

    // Group by category -> subcategory -> product, each carrying the
    // matching brand entries, so the frontend can render a tree instead
    // of a flat list of brand rows.
    const categoriesMap = new Map();

    for (const row of rows) {
        const p = row.product;
        const sc = p?.subcategory;
        const c = sc?.category;
        if (!p || !sc || !c) continue; // skip orphaned brand rows

        if (!categoriesMap.has(c.id)) {
            categoriesMap.set(c.id, { id: c.id, name: c.name, slug: c.slug, subcategories: new Map() });
        }
        const catEntry = categoriesMap.get(c.id);

        if (!catEntry.subcategories.has(sc.id)) {
            catEntry.subcategories.set(sc.id, { id: sc.id, name: sc.name, slug: sc.slug, products: new Map() });
        }
        const subEntry = catEntry.subcategories.get(sc.id);

        if (!subEntry.products.has(p.id)) {
            subEntry.products.set(p.id, { id: p.id, name: p.name, slug: p.slug, brands: [] });
        }
        subEntry.products.get(p.id).brands.push({
            id: row.id,
            name: row.name,
            brandName: row.brand_name,
            image: row.image,
            description: row.description,
            attributes: row.attributes,
        });
    }

    // Flatten the Maps into plain arrays for JSON.
    const categories = [...categoriesMap.values()].map((c) => ({
        ...c,
        subcategories: [...c.subcategories.values()].map((sc) => ({
            ...sc,
            products: [...sc.products.values()],
        })),
    }));

    const totalProducts = categories.reduce(
        (sum, c) => sum + c.subcategories.reduce((s, sc) => s + sc.products.length, 0),
        0
    );

    res.json({
        success: true,
        brandName: term,
        totalMatches: rows.length,
        totalProducts,
        categories,
    });
}