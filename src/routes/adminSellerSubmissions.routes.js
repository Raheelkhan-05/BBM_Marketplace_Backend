import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import { listSellerSubmissions, getSellerSubmission, approveSellerSubmission, rejectSellerSubmission, updateSellerSubmission } from "../controllers/adminSellerSubmissions.controller.js";

const router = Router();
router.get("/", requireAuth, requireAdmin, listSellerSubmissions);
router.get("/:id", requireAuth, requireAdmin, getSellerSubmission);
router.patch("/seller-submissions/:id", requireAdmin, updateSellerSubmission);
router.post("/:id/approve", requireAuth, requireAdmin, authWriteLimiter, approveSellerSubmission);
router.post("/:id/reject", requireAuth, requireAdmin, authWriteLimiter, rejectSellerSubmission);
export default router;