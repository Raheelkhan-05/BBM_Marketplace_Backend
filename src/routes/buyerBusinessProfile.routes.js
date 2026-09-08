import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { getBusinessProfile } from "../controllers/buyerBusinessProfile.controller.js";

const router = Router();
router.use(requireAuth);
router.get("/", getBusinessProfile);
export default router;