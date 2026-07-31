// backend/controllers/catalogLanding.controller.js
//
// Powers the marketing/orientation landing pages (CategoryLandingPage,
// SubcategoryLandingPage) — separate from hierarchy-search drill-down.
//
// v2: pages were too sparse — this now also returns a real `overview`
// paragraph (not just a one-line tagline) and a small preview of actual
// catalog content (top products for a category, top brands for a
// subcategory) so the page has something concrete to show, the same way
// ProductDetailPage shows specs/brands instead of just a description.

import { supabase } from "../config/supabase.js";

const CARD_LIMIT = 8;      // subcategory / product grid cards
const PREVIEW_LIMIT = 6;   // top-products / top-brands strip

function fallbackTagline(name, kind) {
    if (kind === "category") return `Everything you need in ${name} — sourced from verified sellers.`;
    return `Explore ${name} and the sellers who supply it.`;
}

function fallbackOverview(name, kind, subcount) {
    if (kind === "category") {
        return `${name} covers ${subcount > 0 ? `${subcount} subcategories of ` : ""}industrial products sourced from verified sellers across India. Browse by subcategory to find exact specifications, compare brands, and get quotes from sellers who stock it.`;
    }
    return `${name} lists products with detailed specifications from multiple brands. Compare options, check seller ratings, and request quotes directly.`;
}

// GET /api/catalog/category/:idOrSlug
export async function getCategoryLanding(req, res) {
    const { idOrSlug } = req.params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

    const { data: category, error } = await supabase
        .from("hs_categories")
        .select("id, name, slug, image, hero_image, tagline, overview")
        .neq("review_status", "rejected")
        .eq(isUuid ? "id" : "slug", idOrSlug)
        .single();

    if (error || !category) {
        return res.status(404).json({ success: false, message: "Category not found." });
    }

    const { data: subcategories, error: subError } = await supabase
        .from("hs_subcategories")
        .select("id, name, slug, image")
        .neq("review_status", "rejected")
        .eq("category_id", category.id)
        .order("name")
        .limit(CARD_LIMIT);
    if (subError) return res.status(500).json({ success: false, message: subError.message });

    const { count: subcategoryCount } = await supabase
        .from("hs_subcategories")
        .select("id", { count: "exact", head: true })
        .eq("category_id", category.id)
        .neq("review_status", "rejected");

    // Need the FULL subcategory id list (not just the CARD_LIMIT slice) to
    // compute accurate per-card counts + pull a representative product
    // preview from across the whole category, not just the first 8 subs.
    const { data: allSubIds } = await supabase
        .from("hs_subcategories")
        .select("id")
        .eq("category_id", category.id)
        .neq("review_status", "rejected");
    const subIdList = (allSubIds || []).map((s) => s.id);

    let countsBySubcategory = {};
    let totalProducts = 0;
    let topProducts = [];
    let sellerCountTotal = 0;

    if (subIdList.length > 0) {
        const { data: productRows } = await supabase
            .from("hs_products")
            .select("id, name, slug, image, subcategory_id")
            .in("subcategory_id", subIdList)
            .neq("review_status", "rejected");

        for (const row of productRows || []) {
            countsBySubcategory[row.subcategory_id] = (countsBySubcategory[row.subcategory_id] || 0) + 1;
        }
        totalProducts = (productRows || []).length;

        // Prefer products that actually have an image for the preview strip
        // — an empty placeholder icon repeated 6 times looks worse than a
        // shorter, real strip.
        const withImage = (productRows || []).filter((p) => p.image);
        topProducts = (withImage.length >= 3 ? withImage : productRows || []).slice(0, PREVIEW_LIMIT);

        const productIds = (productRows || []).map((p) => p.id);
        if (productIds.length > 0) {
            const { count } = await supabase
                .from("hs_product_sellers")
                .select("id", { count: "exact", head: true })
                .in("product_id", productIds)
                .eq("is_active", true);
            sellerCountTotal = count || 0;
        }
    }

    res.json({
        success: true,
        category: {
            ...category,
            tagline: category.tagline || fallbackTagline(category.name, "category"),
            overview: category.overview || fallbackOverview(category.name, "category", subcategoryCount || 0),
        },
        stats: {
            subcategoryCount: subcategoryCount || 0,
            productCount: totalProducts,
            sellerCount: sellerCountTotal,
        },
        subcategories: (subcategories || []).map((s) => ({
            ...s,
            productCount: countsBySubcategory[s.id] || 0,
        })),
        topProducts,
    });
}

// GET /api/catalog/subcategory/:idOrSlug
export async function getSubcategoryLanding(req, res) {
    const { idOrSlug } = req.params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

    const { data: subcategory, error } = await supabase
        .from("hs_subcategories")
        .select(`
            id, name, slug, image, hero_image, tagline, overview, category_id,
            category:hs_categories ( id, name, slug )
        `)
        .neq("review_status", "rejected")
        .eq(isUuid ? "id" : "slug", idOrSlug)
        .single();

    if (error || !subcategory) {
        return res.status(404).json({ success: false, message: "Subcategory not found." });
    }

    const { data: products, error: prodError } = await supabase
        .from("hs_products")
        .select("id, name, slug, image, description")
        .eq("subcategory_id", subcategory.id)
        .neq("review_status", "rejected")
        .order("name")
        .limit(CARD_LIMIT);
    if (prodError) return res.status(500).json({ success: false, message: prodError.message });

    const { count: productCount } = await supabase
        .from("hs_products")
        .select("id", { count: "exact", head: true })
        .eq("subcategory_id", subcategory.id)
        .neq("review_status", "rejected");

    // Need every product id under this subcategory (not just the CARD_LIMIT
    // slice) to get accurate seller counts + a representative brand preview.
    const { data: allProductRows } = await supabase
        .from("hs_products")
        .select("id")
        .eq("subcategory_id", subcategory.id)
        .neq("review_status", "rejected");
    const allProductIds = (allProductRows || []).map((p) => p.id);

    let sellerCountByProduct = {};
    let topBrands = [];
    let sellerCountTotal = 0;

    if (allProductIds.length > 0) {
        const { data: sellerRows } = await supabase
            .from("hs_product_sellers")
            .select("product_id")
            .in("product_id", allProductIds)
            .eq("is_active", true);
        for (const row of sellerRows || []) {
            sellerCountByProduct[row.product_id] = (sellerCountByProduct[row.product_id] || 0) + 1;
        }
        sellerCountTotal = (sellerRows || []).length;

        const { data: brandRows } = await supabase
            .from("hs_product_brands")
            .select("id, name, brand_name, image, product_id")
            .in("product_id", allProductIds)
            .neq("review_status", "rejected")
            .limit(PREVIEW_LIMIT * 3); // over-fetch a little, dedupe by brand_name below

        const seenBrandNames = new Set();
        topBrands = [];
        for (const b of brandRows || []) {
            const key = (b.brand_name || b.name).trim().toLowerCase();
            if (seenBrandNames.has(key)) continue;
            seenBrandNames.add(key);
            topBrands.push(b);
            if (topBrands.length >= PREVIEW_LIMIT) break;
        }
    }

    res.json({
        success: true,
        subcategory: {
            ...subcategory,
            tagline: subcategory.tagline || fallbackTagline(subcategory.name, "subcategory"),
            overview: subcategory.overview || fallbackOverview(subcategory.name, "subcategory", 0),
        },
        stats: {
            productCount: productCount || 0,
            sellerCount: sellerCountTotal,
            brandCount: topBrands.length,
        },
        products: (products || []).map((p) => ({
            ...p,
            sellerCount: sellerCountByProduct[p.id] || 0,
        })),
        topBrands,
    });
}