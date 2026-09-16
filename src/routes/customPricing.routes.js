// routes/customPricing.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import {
    listCustomPricingForBuyer, upsertCustomPricing, deleteCustomPricing, bulkClearCustomPricing,
} from "../controllers/customPricing.controller.js";

const router = Router();
router.use(requireAuth, requireApprovedSeller);

router.get("/:buyerId", listCustomPricingForBuyer);
router.post("/:buyerId", upsertCustomPricing);
router.delete("/:buyerId/:submissionId", deleteCustomPricing);
router.post("/:buyerId/bulk-clear", bulkClearCustomPricing);

export default router;

// mount: app.use("/api/seller/custom-pricing", customPricingRoutes);