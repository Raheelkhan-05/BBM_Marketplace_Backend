// src/routes/auth.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authWriteLimiter, otpLimiter } from "../middleware/rateLimiter.js";
import { getMe, lookupGstin, completeProfile, saveProgress } from "../controllers/auth.controller.js";
import { requestLoginOtp, verifyLoginOtp } from "../controllers/otpAuth.controller.js";
import { requestContactOtp, verifyContactOtp } from "../controllers/contactVerification.controller.js";

const router = Router();

router.post("/request-otp", otpLimiter, requestLoginOtp);
router.post("/verify-otp", otpLimiter, verifyLoginOtp);
router.get("/me", requireAuth, getMe);
router.post("/gst-lookup", requireAuth, lookupGstin);
router.post("/complete-profile", requireAuth, authWriteLimiter, completeProfile);
router.post("/save-progress", requireAuth, authWriteLimiter, saveProgress);
router.post("/contact/request-otp", requireAuth, authWriteLimiter, requestContactOtp);
router.post("/contact/verify-otp", requireAuth, authWriteLimiter, verifyContactOtp);

export default router;