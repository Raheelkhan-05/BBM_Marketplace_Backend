import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
    listSellerSubmissions,
    getSellerSubmission,
    updateSellerSubmission,
    approveSellerSubmission,
    rejectSellerSubmission,
    listSubmissionsForBrandItem,
} from "../controllers/adminSellerSubmissions.controller.js";

const router = Router();

router.get("/", requireAuth, requireAdmin, listSellerSubmissions);
// NOTE: must be registered before "/:id" so "by-brand-item" isn't
// swallowed as an :id param.
router.get("/by-brand-item/:brandItemId", requireAuth, requireAdmin, listSubmissionsForBrandItem);
router.get("/:id", requireAuth, requireAdmin, getSellerSubmission);
// NOTE: previously mounted as "/seller-submissions/:id" on a router that
// is itself already mounted at .../admin/seller-submissions, and without
// requireAuth — that meant the real path was .../seller-submissions/
// seller-submissions/:id and unauthenticated. Fixed to the same "/:id"
// base path every other verb here uses.
router.patch("/:id", requireAuth, requireAdmin, authWriteLimiter, updateSellerSubmission);
router.post("/:id/approve", requireAuth, requireAdmin, authWriteLimiter, approveSellerSubmission);
router.post("/:id/reject", requireAuth, requireAdmin, authWriteLimiter, rejectSellerSubmission);

export default router;