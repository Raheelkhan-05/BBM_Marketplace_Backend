// src/routes/impersonation.routes.js  (mount: app.use("/api/impersonation", ...))
import { Router } from "express";
import { otpLimiter } from "../middleware/rateLimiter.js";
import { exchangeCode, getCurrent, endSession, requireImpersonation } from "../controllers/impersonation.controller.js";

const router = Router();
router.post("/exchange", otpLimiter, exchangeCode);
router.get("/current", requireImpersonation, getCurrent);
router.post("/end", requireImpersonation, endSession);
export default router;