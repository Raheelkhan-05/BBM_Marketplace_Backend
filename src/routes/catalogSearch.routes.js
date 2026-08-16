import { Router } from "express";
import {
    searchCategoriesV2,
    searchSubcategoriesV2,
    searchGenericProductsV2,
    searchBrandItemsV2,
    searchSellersForBrandItemV2,
    searchHierarchyV2,
    smartSearchV2,
    searchAutocompleteV2,
} from "../controllers/catalogHierarchySearch.controller.js";
import { browseCatalog, browseGenericProducts } from "../controllers/catalogBrowse.controller.js";
import { optionalAuthListing } from "../middleware/optionalAuthListing.middleware.js";
import { listGenericProductSellers, getPublicListingDetail, listApprovedBrandsForGenericProduct } from "../controllers/catalogGenericProductSellers.controller.js";
import { refreshHomeFeedCache } from "../services/homeFeedCache.service.js";
import { supabase } from "../config/supabase.js";
import { verifyCronSecret } from "../middleware/verifyCronSecret.js";


// New, admin-approved-only search hierarchy. Fully additive — the
// original /api/search routes (hierarchysearch.controller.js) are
// untouched and keep working exactly as before.
const router = Router();

router.get("/categories", searchCategoriesV2);
router.get("/subcategories", searchSubcategoriesV2);
router.get("/generic-products", searchGenericProductsV2);
router.get("/brand-items", searchBrandItemsV2);
router.get("/sellers", optionalAuthListing, searchSellersForBrandItemV2);
router.get("/hierarchy", searchHierarchyV2);
router.get("/browse", optionalAuthListing, browseCatalog);
router.get("/smart", smartSearchV2);
router.get("/autocomplete", searchAutocompleteV2);

router.get("/browse-products", optionalAuthListing, browseGenericProducts);
router.get("/generic-product-sellers", listGenericProductSellers);
router.get("/listing/:id", getPublicListingDetail);
router.get("/generic-products/:id/brands", listApprovedBrandsForGenericProduct);

// Public, paginated read — this is what every visitor's browser calls.
router.get("/home-feed", async (req, res) => {
    const cursor = Math.max(0, parseInt(req.query.cursor || "0", 10));
    const limit = Math.min(Math.max(1, parseInt(req.query.limit || "3", 10)), 10);

    const { data, error } = await supabase
        .from("home_feed_cache")
        .select("shelf_order, category, items")
        .order("shelf_order", { ascending: true })
        .range(cursor, cursor + limit); // fetch one extra to know if there's more

    if (error) {
        return res.status(500).json({ success: false, message: "Couldn't load the feed." });
    }

    const hasMore = data.length > limit;
    const page = data.slice(0, limit);

    res.json({
        success: true,
        shelves: page.map((r) => ({ category: r.category, items: r.items })),
        nextCursor: cursor + page.length,
        hasMore,
    });
});

// Cron-triggered refresh — same pattern as your BBM CRM pending-tasks digest.
router.post("/home-feed/refresh", verifyCronSecret, async (req, res) => {
    try {
        const result = await refreshHomeFeedCache();
        res.json({ success: true, ...result });
    } catch (err) {
        console.error("home-feed refresh failed", err);
        res.status(500).json({ success: false, message: "Refresh failed." });
    }
});

export default router;