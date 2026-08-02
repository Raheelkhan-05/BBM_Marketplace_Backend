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
const FAMILY_GROUP_PRODUCT_PREVIEW = 6; // items shown per subcategory group before "view more"


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

// GET /api/catalog/brand/:idOrSlug
export async function getBrandDetail(req, res) {
    const { idOrSlug } = req.params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

    const { data: brand, error } = await supabase
        .from("hs_product_brands")
        .select(`
            id, name, slug, image, brand_name, description, attributes, product_id,
            product:hs_products (
                id, name, slug, subcategory_id,
                subcategory:hs_subcategories (
                    id, name, slug, category_id,
                    category:hs_categories ( id, name, slug )
                )
            )
        `)
        .neq("review_status", "rejected")
        .eq(isUuid ? "id" : "slug", idOrSlug)
        .single();

    if (error || !brand) {
        return res.status(404).json({ success: false, message: "Brand item not found." });
    }

    // Flatten the nested product/subcategory/category the same shape the
    // frontend expects (brand.product / brand.subcategory / brand.category),
    // instead of the raw nested Supabase join shape.
    const product = brand.product || null;
    const subcategory = product?.subcategory || null;
    const category = subcategory?.category || null;

    // Sibling SKUs: every OTHER hs_product_brands row sharing the same
    // brand_name, regardless of which product they're filed under — a
    // buyer on "Yogi Hi-Tech 13070 FWT" should see ALL Yogi Hi-Tech SKUs,
    // not just ones under this exact product line. Falls back to
    // comparing `name` if brand_name was never set (is_branded rows
    // always have brand_name, but guard anyway).
    let siblingBrandItems = [];
    const brandNameKey = brand.brand_name || brand.name;
    if (brandNameKey) {
        const { data: siblingRows } = await supabase
            .from("hs_product_brands")
            .select("id, name, image, brand_name")
            .neq("review_status", "rejected")
            .neq("id", brand.id)
            .ilike("brand_name", brandNameKey)
            .order("name")
            .limit(PREVIEW_LIMIT * 3); // over-fetch slightly in case of near-duplicate casing, trimmed below

        siblingBrandItems = (siblingRows || []).slice(0, PREVIEW_LIMIT);
    }

    // Seller count scoped to this exact brand item (SKU-level), not the
    // whole product line — a buyer here wants to know how many sellers
    // stock THIS specific part number.
    const { count: sellerCount } = await supabase
        .from("hs_product_sellers")
        .select("id", { count: "exact", head: true })
        .eq("brand_id", brand.id)
        .eq("is_active", true);

    res.json({
        success: true,
        brand: {
            id: brand.id,
            name: brand.name,
            slug: brand.slug,
            image: brand.image,
            brand_name: brand.brand_name,
            description: brand.description,
            attributes: brand.attributes || {},
            product: product ? { id: product.id, name: product.name, slug: product.slug } : null,
            subcategory: subcategory ? { id: subcategory.id, name: subcategory.name, slug: subcategory.slug } : null,
            category: category ? { id: category.id, name: category.name, slug: category.slug } : null,
        },
        siblingBrandItems,
        sellerCount: sellerCount || 0,
    });
}

// GET /api/catalog/brand-family/:brandName
// Unlike getBrandDetail (one specific SKU + its immediate siblings under
// the SAME product), this returns EVERY brand item across the WHOLE
// catalog that shares this brand_name — regardless of category,
// subcategory, or product line. This is what a search for the brand
// itself (e.g. "ZXL Bearing") should land on, not any single SKU page.
export async function getBrandFamily(req, res) {
    const { brandName } = req.params;
    const decoded = decodeURIComponent(brandName || "").trim();
    if (!decoded) return res.status(400).json({ success: false, message: "Brand name required." });

    const { data: items, error } = await supabase
        .from("hs_product_brands")
        .select(`
            id, name, slug, image, brand_name,
            product:hs_products (
                id, name,
                subcategory:hs_subcategories (
                    id, name, slug,
                    category:hs_categories ( id, name, slug )
                )
            )
        `)
        .neq("review_status", "rejected")
        .ilike("brand_name", decoded);

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!items?.length) return res.status(404).json({ success: false, message: "Brand not found." });

    // Group into category -> subcategory -> [items], since a brand can
    // span wildly different parts of the catalog (bearings, oils,
    // fasteners, etc. all under the same manufacturer).
    const categoryMap = new Map();
    for (const item of items) {
        const subcat = item.product?.subcategory;
        const cat = subcat?.category;
        const catKey = cat?.id || "uncategorized";
        if (!categoryMap.has(catKey)) {
            categoryMap.set(catKey, {
                id: cat?.id || null, name: cat?.name || "Uncategorized", slug: cat?.slug || null,
                subcategories: new Map(),
            });
        }
        const catEntry = categoryMap.get(catKey);
        const subKey = subcat?.id || "uncategorized";
        if (!catEntry.subcategories.has(subKey)) {
            catEntry.subcategories.set(subKey, {
                id: subcat?.id || null, name: subcat?.name || "Uncategorized", slug: subcat?.slug || null,
                items: [],
            });
        }
        catEntry.subcategories.get(subKey).items.push({
            id: item.id, name: item.name, slug: item.slug, image: item.image,
            productName: item.product?.name || null,
        });
    }

    const categories = [...categoryMap.values()].map((c) => ({
        ...c,
        subcategories: [...c.subcategories.values()],
    }));

    // Seller count across every SKU under this brand family.
    const brandItemIds = items.map((i) => i.id);
    const { count: sellerCount } = await supabase
        .from("hs_product_sellers")
        .select("id", { count: "exact", head: true })
        .in("brand_id", brandItemIds)
        .eq("is_active", true);

    res.json({
        success: true,
        brandName: items[0].brand_name || decoded,
        stats: {
            skuCount: items.length,
            categoryCount: categories.length,
            sellerCount: sellerCount || 0,
        },
        categories,
    });
}