import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import { helpRequestLimiter } from "../middleware/rateLimiter.js";
import {
    getMyHelpStatus, markResolutionSeen, createHelpRequest,
    adminListHelpRequests, adminAcknowledgeHelpRequest, adminResolveHelpRequest,
} from "../controllers/help.controller.js";

const router = Router();
router.get("/status", requireAuth, getMyHelpStatus);
router.post("/:id/seen", requireAuth, markResolutionSeen);
router.post("/trigger", requireAuth, helpRequestLimiter, createHelpRequest);
router.get("/admin/list", requireAuth, requireAdmin, adminListHelpRequests);
router.post("/admin/:id/acknowledge", requireAuth, requireAdmin, adminAcknowledgeHelpRequest);
router.post("/admin/:id/resolve", requireAuth, requireAdmin, adminResolveHelpRequest);
export default router;