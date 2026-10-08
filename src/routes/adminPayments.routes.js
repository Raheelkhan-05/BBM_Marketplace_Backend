// src/routes/adminPayments.routes.js — mounted at /api/admin/payments (BEFORE /api/admin in app.js)
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import { listAttempts, recheckAttempt, listRefunds, retryRefund } from "../controllers/adminPayments.controller.js";

const router = Router();

router.get("/attempts", requireAuth, requireAdmin, listAttempts);
router.post("/attempts/:id/recheck", requireAuth, requireAdmin, authWriteLimiter, recheckAttempt);
router.get("/refunds", requireAuth, requireAdmin, listRefunds);
router.post("/refunds/:id/retry", requireAuth, requireAdmin, authWriteLimiter, retryRefund);

export default router;