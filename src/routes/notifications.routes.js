import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { listNotifications, markNotificationRead, markAllRead } from "../controllers/notifications.controller.js";

const router = Router();
router.get("/", requireAuth, listNotifications);
router.post("/:id/read", requireAuth, markNotificationRead);
router.post("/read-all", requireAuth, markAllRead);

export default router;