// src/routes/catalog.routes.js
// Merge into your existing catalog router if you have one — these are all
// public, read-only, cacheable-at-the-edge endpoints (no requireAuth), same
// as your existing "public read categories/products/subcategories" RLS
// policies already assume.

import { Router } from "express";
import { optionalAuth } from "../middleware/optionalAuth.middleware.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import {
    getCategoryGenericProducts,
    getGenericProductBrands,
    getBrandItemDetail,
    getBrandItemSellers,
    getGenericProductsFeed,
    getBrandItemsFeed,
    getBrandItemSellerOffer,
    getSharedProductLink
} from "../controllers/catalog.controller.js";

const router = Router();

router.get("/categories/:categoryId/generic-products", optionalAuth, getCategoryGenericProducts);
router.get("/generic-products", optionalAuth, getGenericProductsFeed);
router.get("/generic-products/:genericProductId/brands", optionalAuth, getGenericProductBrands);
router.get("/brand-items/:brandItemId", optionalAuth, getBrandItemDetail);
router.get("/brand-items-feed", optionalAuth, getBrandItemsFeed);
router.get("/brand-items/:brandItemId/sellers", optionalAuth, getBrandItemSellers);
router.get("/brand-items/:brandItemId/seller-offer", optionalAuth, getBrandItemSellerOffer);
router.get("/shared/:submissionId", getSharedProductLink);

export default router;

// In your main router file:
//   import catalogRoutes from "./routes/catalog.routes.js";
//   app.use("/api/catalog", catalogRoutes);