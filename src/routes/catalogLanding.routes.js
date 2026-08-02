// backend/routes/catalogLanding.routes.js
//
// Mount this in your main app file alongside the existing search router,
// e.g.:
//   import catalogLandingRoutes from "./routes/catalogLanding.routes.js";
//   app.use("/api/catalog", catalogLandingRoutes);
//
// Does not touch or replace anything under /api/search — that router
// (hierarchysearch.controller.js) stays exactly as-is.

import { Router } from "express";
import { getCategoryLanding, getSubcategoryLanding, getBrandDetail, getBrandFamily } from "../controllers/catalogLanding.controller.js";

const router = Router();

router.get("/category/:idOrSlug", getCategoryLanding);
router.get("/subcategory/:idOrSlug", getSubcategoryLanding);
router.get("/brand/:idOrSlug", getBrandDetail);
router.get("/brand-family/:brandName", getBrandFamily); // note: register AFTER /brand/:idOrSlug to avoid route-order ambiguity issues in some router configs — Express matches by path shape here so order is fine, but keep this comment as a flag if you ever add wildcard routes nearby

export default router;