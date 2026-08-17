// src/routes/catalog.routes.js
// Merge into your existing catalog router if you have one — these are all
// public, read-only, cacheable-at-the-edge endpoints (no requireAuth), same
// as your existing "public read categories/products/subcategories" RLS
// policies already assume.

import { Router } from "express";
import {
    getCategoryGenericProducts,
    getGenericProductBrands,
    getBrandItemDetail,
    getBrandItemSellers,
    getGenericProductsFeed,
} from "../controllers/catalog.controller.js";

const router = Router();

router.get("/categories/:categoryId/generic-products", getCategoryGenericProducts);
router.get("/generic-products", getGenericProductsFeed);
router.get("/generic-products/:genericProductId/brands", getGenericProductBrands);
router.get("/brand-items/:brandItemId", getBrandItemDetail);
router.get("/brand-items/:brandItemId/sellers", getBrandItemSellers);

export default router;

// In your main router file:
//   import catalogRoutes from "./routes/catalog.routes.js";
//   app.use("/api/catalog", catalogRoutes);