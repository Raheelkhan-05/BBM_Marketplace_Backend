// src/routes/salesMonitor.routes.js   (mount: app.use("/api/sales-monitor", salesMonitorRoutes))
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { getPeople, getFeed, getThreadView } from "../controllers/salesMonitor.controller.js";

const router = Router();
router.use(requireAuth);
router.get("/people", getPeople);
router.get("/feed", getFeed);
router.get("/threads/:id", getThreadView);
export default router;