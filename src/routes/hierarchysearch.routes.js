import { Router } from "express";
import {
    searchCategories,
    searchSubcategories,
    searchProducts,
    searchSellersForProduct,
    searchHierarchy,
    smartSearch,
} from "../controllers/hierarchysearch.controller.js";

const router = Router();

// Level-specific endpoints (clearest for direct use / testing)
router.get("/categories", searchCategories);
router.get("/subcategories", searchSubcategories);
router.get("/products", searchProducts);
router.get("/sellers", searchSellersForProduct);

// Convenience single endpoint — what the frontend hook actually calls
router.get("/hierarchy", searchHierarchy);

// Cross-level search — fallback when a scoped search comes up empty
router.get("/smart", smartSearch);

export default router;
