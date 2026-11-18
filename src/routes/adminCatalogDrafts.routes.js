// routes/adminCatalogDrafts.routes.js  (mounted at /api/admin/catalog-bulk)
import express from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import {
    getMeta, checkRows,
    listDrafts, createDrafts, updateDraft, deleteDraft, clearDrafts,
    deleteDraftsBulk, setDraftImages, submitDrafts,
} from "../controllers/adminCatalogDrafts.controller.js";
import { enqueueImages, listJobs, ackImages, cancelImages } from "../controllers/adminCatalogImages.controller.js";
import { startCatalogImageWorker } from "../services/catalogImageQueue.service.js";

// The AI image worker starts when the server boots (this file is imported at startup).
startCatalogImageWorker();

const router = express.Router();
const guard = [requireAuth, requireAdmin];

router.get("/meta", guard, getMeta);
router.post("/check", guard, checkRows);

router.get("/drafts", guard, listDrafts);
router.post("/drafts", guard, createDrafts);
router.post("/drafts/images", guard, setDraftImages);
router.post("/drafts/delete", guard, deleteDraftsBulk);
router.post("/drafts/submit", guard, submitDrafts);
router.delete("/drafts", guard, clearDrafts);
router.patch("/drafts/:id", guard, updateDraft);
router.delete("/drafts/:id", guard, deleteDraft);

// AI product images (background queue)
router.post("/ai-images/enqueue", guard, enqueueImages);
router.get("/ai-images/jobs", guard, listJobs);
router.post("/ai-images/ack", guard, ackImages);
router.post("/ai-images/cancel", guard, cancelImages);

export default router;