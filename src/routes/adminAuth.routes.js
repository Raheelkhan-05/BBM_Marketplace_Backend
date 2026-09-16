// routes/adminAuth.routes.js — PUBLIC route, no requireAuth (it IS the login)
import { Router } from "express";
import { otpLimiter } from "../middleware/rateLimiter.js";
import { requestAdminLoginOtp, verifyAdminLoginOtp } from "../controllers/adminOtpAuth.controller.js";

const router = Router();
router.post("/request-otp", otpLimiter, requestAdminLoginOtp);
router.post("/verify-otp", otpLimiter, verifyAdminLoginOtp);
export default router;