import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
  getSellerOnboarding,
  saveSellerOnboarding,
  submitSellerOnboarding,
  uploadSellerFile,
} from "../controllers/seller.controller.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.get("/onboarding", requireAuth, getSellerOnboarding);
router.post("/onboarding/save", requireAuth, authWriteLimiter, saveSellerOnboarding);
router.post("/onboarding/submit", requireAuth, authWriteLimiter, submitSellerOnboarding);
router.post("/upload", requireAuth, authWriteLimiter, upload.single("file"), uploadSellerFile);

export default router;