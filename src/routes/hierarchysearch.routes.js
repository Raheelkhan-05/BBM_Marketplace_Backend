import { Router } from "express";
import {
    searchCategories,
    searchSubcategories,
    searchProducts,
    searchSellersForProduct,
    searchHierarchy,
    searchBrands,
    smartSearch,
    searchAutocomplete
} from "../controllers/hierarchysearch.controller.js";
import { resolveWithAI } from "../controllers/aiCatalogResolve.controller.js";
import { identifyProductFromImage } from "../controllers/imageSearch.controller.js";
import { getImageStatuses } from "../controllers/catalogImageStatus.controller.js"

const router = Router();

// Level-specific endpoints (clearest for direct use / testing)
router.get("/categories", searchCategories);
router.get("/subcategories", searchSubcategories);
router.get("/products", searchProducts);
router.get("/brands", searchBrands);
router.get("/sellers", searchSellersForProduct);

// Convenience single endpoint — what the frontend hook actually calls
router.get("/hierarchy", searchHierarchy);

// Cross-level search — fallback when a scoped search comes up empty
router.get("/smart", smartSearch);

// AI last-resort resolver — only called when the buyer explicitly taps
// "Search with AI" after scoped + smart search both come up empty.
router.post("/ai-resolve", resolveWithAI);

// Image-based search — identifies the product in a buyer-uploaded photo
// and returns a search term for the normal pipeline above.
router.post("/image", identifyProductFromImage);

router.get("/image-status", getImageStatuses);

// Fast, pure-DB typeahead — no AI, no image work. Called on every
// keystroke (debounced client-side), so keep this endpoint cheap.
router.get("/autocomplete", searchAutocomplete);

export default router;