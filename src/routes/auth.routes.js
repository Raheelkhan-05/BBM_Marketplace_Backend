// src/routes/auth.routes.js

import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import { registerProfile, submitCompany, getMe, lookupGstin } from "../controllers/auth.controller.js";
import { devRequestPhoneOtp, devVerifyPhoneOtp } from "../controllers/phoneDevAuth.controller.js";
import { requestContactOtp, verifyContactOtp } from "../controllers/contactVerification.controller.js";

const router = Router();

router.post("/phone/dev-request", devRequestPhoneOtp);
router.post("/phone/dev-verify", devVerifyPhoneOtp);
router.get("/me", requireAuth, getMe);
router.post("/register", requireAuth, authWriteLimiter, registerProfile);
router.post("/gst-lookup", requireAuth, lookupGstin);
router.post("/company", requireAuth, authWriteLimiter, submitCompany);
router.post("/contact/request-otp", requireAuth, authWriteLimiter, requestContactOtp);
router.post("/contact/verify-otp", requireAuth, authWriteLimiter, verifyContactOtp);

export default router;