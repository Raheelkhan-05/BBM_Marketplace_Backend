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
import { getCategoryLanding, getSubcategoryLanding } from "../controllers/catalogLanding.controller.js";

const router = Router();

router.get("/category/:idOrSlug", getCategoryLanding);
router.get("/subcategory/:idOrSlug", getSubcategoryLanding);

export default router;