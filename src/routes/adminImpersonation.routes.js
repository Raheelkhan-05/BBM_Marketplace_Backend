// src/routes/adminImpersonation.routes.js  (mount: app.use("/api/admin/impersonation", ...), BEFORE "/api/admin")
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
    requireRealAdmin, searchUsers, startImpersonation, listSessions, getSessionLog, revokeSession,
} from "../controllers/adminImpersonation.controller.js";

const router = Router();
router.use(requireAuth, requireRealAdmin);

router.get("/search", searchUsers);
router.post("/start", authWriteLimiter, startImpersonation);
router.get("/sessions", listSessions);
router.get("/sessions/:id/log", getSessionLog);
router.post("/sessions/:id/revoke", authWriteLimiter, revokeSession);

export default router;