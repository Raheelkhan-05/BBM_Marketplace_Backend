// routes/productCommission.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import { listProductCommissions, setProductCommission } from "../controllers/productCommission.controller.js";

const router = Router();

router.get("/products/commissions", requireAuth, requireAdmin, listProductCommissions);
router.patch("/products/:id/commission", requireAuth, requireAdmin, authWriteLimiter, setProductCommission);

export default router;