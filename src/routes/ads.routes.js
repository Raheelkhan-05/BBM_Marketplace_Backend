// Mount:  app.use("/api/ads", adsRoutes);
//         adminAdsRoutes goes under the SAME guard you use for /api/admin/group-banners
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import { shapeUploader } from "../services/bannerImages.service.js";
import * as c from "../controllers/ads.controller.js";
import { getMyAdProducts } from "../controllers/adsProducts.controller.js";

const readLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const upload = shapeUploader();

const router = Router();
router.get("/live", readLimiter, c.getLive);
router.get("/placements", requireAuth, requireApprovedSeller, readLimiter, c.getPlacements);
router.get("/placements/:key/availability", requireAuth, requireApprovedSeller, readLimiter, c.getAvailability);
router.get("/placements/:key/quote", requireAuth, requireApprovedSeller, readLimiter, c.getQuote);
router.post("/creatives", requireAuth, requireApprovedSeller, authWriteLimiter, upload, c.uploadCreative);
router.post("/bookings", requireAuth, requireApprovedSeller, authWriteLimiter, c.postBooking);
router.get("/bookings", requireAuth, requireApprovedSeller, readLimiter, c.getMyBookings);
router.get("/my-products", requireAuth, requireApprovedSeller, readLimiter, getMyAdProducts); // NEW (Stage 3)
export default router;

export const adminAdsRoutes = Router();
adminAdsRoutes.get("/placements", c.adminPlacements);
adminAdsRoutes.patch("/placements/:id", c.adminPatchPlacement);
adminAdsRoutes.patch("/settings", c.adminPatchSettings);
adminAdsRoutes.get("/overrides", c.adminOverrides);
adminAdsRoutes.post("/overrides", c.adminPostOverride);
adminAdsRoutes.delete("/overrides/:id", c.adminDeleteOverride);
adminAdsRoutes.get("/pricing", c.adminPricing);
adminAdsRoutes.get("/bookings", c.adminBookings);
adminAdsRoutes.post("/bookings/:id/remove", c.adminRemove);