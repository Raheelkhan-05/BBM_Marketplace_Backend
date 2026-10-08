// src/routes/payments.routes.js — mounted at /api/payments (after CORS + JSON parsing)
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import { checkoutOrder, checkoutGroup, checkoutWallet, attemptStatus } from "../controllers/payments.controller.js";

const router = Router();

const statusLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });

router.post("/orders/:orderId/checkout", requireAuth, authWriteLimiter, checkoutOrder);
router.post("/groups/:groupId/checkout", requireAuth, authWriteLimiter, checkoutGroup);
router.post("/wallet/checkout", requireAuth, requireApprovedSeller, authWriteLimiter, checkoutWallet);
router.get("/attempts/:ref", requireAuth, statusLimiter, attemptStatus);

export default router;