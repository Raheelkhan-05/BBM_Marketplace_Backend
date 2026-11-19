import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
    listImageRequests, approveImageRequest, rejectImageRequest, listImageAudit, rollbackImages, rollbackPreview
} from "../controllers/adminProductImageRequests.controller.js";

const router = Router();
router.get("/", requireAuth, requireAdmin, listImageRequests);
router.get("/audit", requireAuth, requireAdmin, listImageAudit);   // before "/:id" routes
router.get("/rollback-preview", requireAuth, requireAdmin, rollbackPreview);
router.post("/rollback", requireAuth, requireAdmin, authWriteLimiter, rollbackImages);
router.post("/:id/approve", requireAuth, requireAdmin, authWriteLimiter, approveImageRequest);
router.post("/:id/reject", requireAuth, requireAdmin, authWriteLimiter, rejectImageRequest);
export default router;