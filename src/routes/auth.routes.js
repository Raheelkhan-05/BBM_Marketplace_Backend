// src/routes/auth.routes.js

import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import { registerProfile, submitCompany, getMe } from "../controllers/auth.controller.js";
import { devRequestPhoneOtp, devVerifyPhoneOtp } from "../controllers/phoneDevAuth.controller.js";


const router = Router();

// Note: OTP request/verify are NOT here — they go straight from the
// frontend to Supabase Auth (see utils/supabaseClient.js on the client).
// Everything below only runs once a Supabase session/JWT already exists.
// src/routes/auth.routes.js — add these two lines

router.post("/phone/dev-request", devRequestPhoneOtp);
router.post("/phone/dev-verify", devVerifyPhoneOtp);
router.get("/me", requireAuth, getMe);
router.post("/register", requireAuth, authWriteLimiter, registerProfile);
router.post("/company", requireAuth, authWriteLimiter, submitCompany);

export default router;