// src/routes/team.routes.js   (mount: app.use("/api/team", teamRoutes))
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authWriteLimiter, otpLimiter } from "../middleware/rateLimiter.js";
import {
    getTeam, getActivity, createInvite, resendInvite, revokeInvite, removeMember,
    setMemberRole,
    getInviteInfo, requestJoinOtp, acceptInvite,
} from "../controllers/team.controller.js";

const router = Router();

// Public: the invite link itself is the credential.
router.get("/join/:token", otpLimiter, getInviteInfo);
router.post("/join/:token/request-otp", otpLimiter, requestJoinOtp);
router.post("/join/:token/accept", otpLimiter, acceptInvite);

router.use(requireAuth);
router.get("/", getTeam);
router.get("/activity", getActivity);
router.post("/invites", authWriteLimiter, createInvite);
router.post("/invites/:id/resend", authWriteLimiter, resendInvite);
router.delete("/invites/:id", authWriteLimiter, revokeInvite);
router.delete("/members/:userId", authWriteLimiter, removeMember);
router.patch("/members/:userId/role", authWriteLimiter, setMemberRole);

export default router;