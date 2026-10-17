// routes/bulkListings.routes.js
// mount: app.use("/api/seller/bulk", bulkListingsRoutes);
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import {
    bulkSummary, listBulkItems, createBulkItems, updateBulkItem, markBulkItem, deleteBulkItem, clearBulkItems,
} from "../controllers/bulkListings.controller.js";

const router = Router();
router.use(requireAuth, requireApprovedSeller);

router.get("/summary", bulkSummary);
router.get("/items", listBulkItems);
router.post("/items", createBulkItems);
router.delete("/items", clearBulkItems);
router.patch("/items/:id", updateBulkItem);
router.post("/items/:id/mark", markBulkItem);
router.delete("/items/:id", deleteBulkItem);

export default router;