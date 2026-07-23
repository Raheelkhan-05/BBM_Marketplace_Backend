import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
  listSellers, getSellerDetail, updateSellerAsAdmin, approveSeller, rejectSeller,
  searchUsers, listAdmins, promoteToAdmin, demoteAdmin
} from "../controllers/admin.controller.js";

const router = Router();

router.get("/sellers", requireAuth, requireAdmin, listSellers);
router.get("/sellers/:id", requireAuth, requireAdmin, getSellerDetail);
router.patch("/sellers/:id", requireAuth, requireAdmin, authWriteLimiter, updateSellerAsAdmin);
router.post("/sellers/:id/approve", requireAuth, requireAdmin, authWriteLimiter, approveSeller);
router.post("/sellers/:id/reject", requireAuth, requireAdmin, authWriteLimiter, rejectSeller);

router.get("/users/search", requireAuth, requireAdmin, searchUsers);
router.get("/admins", requireAuth, requireAdmin, listAdmins);
router.post("/admins/promote", requireAuth, requireAdmin, authWriteLimiter, promoteToAdmin);
router.post("/admins/demote", requireAuth, requireAdmin, authWriteLimiter, demoteAdmin);

export default router;