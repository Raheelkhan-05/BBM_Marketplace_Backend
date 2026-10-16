import { Router } from "express";
import multer from "multer";
import { requireAuth, optionalAuth } from "../middleware/auth.middleware.js";
import { authWriteLimiter, anonUploadLimiter, } from "../middleware/rateLimiter.js";
import { requireTeamAdmin, announceOnSellerLive } from "../middleware/teamContext.middleware.js";
import {
  getSellerOnboarding,
  saveSellerOnboarding,
  submitSellerOnboarding,
  uploadSellerFile,
  getSellerDashboard,
  updateSellerProfile,
  updateSellerTheme,
  addSellerCertification,
  deleteSellerPhoto,
  addSellerPhoto,
  deleteSellerCertification,
  listOwnSellerProducts,
  createSellerProduct,
  deleteSellerProduct,
  updateSellerProduct,
  requestSellerWhatsappOtp,
  verifySellerWhatsappOtp,
  uploadAnonymousSellerFile,
  getSellerBankDetails,
  saveSellerBankDetails,
  getSellerOwnGstin,
} from "../controllers/seller.controller.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Team mode: only the team admin sets up the company as a seller (and its payout bank account).
router.get("/onboarding", requireAuth, getSellerOnboarding);
router.post("/onboarding/save", requireAuth, requireTeamAdmin, authWriteLimiter, saveSellerOnboarding);
router.post("/onboarding/submit", requireAuth, requireTeamAdmin, authWriteLimiter, announceOnSellerLive, submitSellerOnboarding);

router.post("/upload", optionalAuth, anonUploadLimiter, upload.single("file"), uploadSellerFile);
router.get("/bank-details", requireAuth, getSellerBankDetails);
router.post("/bank-details", requireAuth, requireTeamAdmin, authWriteLimiter, saveSellerBankDetails);
router.post(
  "/onboarding/anonymous-upload",
  anonUploadLimiter,
  upload.single("file"),
  uploadAnonymousSellerFile
);
router.get("/gstin", requireAuth, getSellerOwnGstin);
router.post("/onboarding/whatsapp/request-otp", requireAuth, requireTeamAdmin, authWriteLimiter, requestSellerWhatsappOtp);
router.post("/onboarding/whatsapp/verify-otp", requireAuth, requireTeamAdmin, authWriteLimiter, verifySellerWhatsappOtp);

router.get("/dashboard", requireAuth, getSellerDashboard);
router.patch("/profile", requireAuth, updateSellerProfile);
router.patch("/theme", requireAuth, updateSellerTheme);
router.post("/photos", requireAuth, addSellerPhoto);
router.delete("/photos/:id", requireAuth, deleteSellerPhoto);
router.post("/certifications", requireAuth, addSellerCertification);
router.delete("/certifications/:id", requireAuth, deleteSellerCertification);
router.get("/products", requireAuth, listOwnSellerProducts);
router.post("/products", requireAuth, createSellerProduct);
router.patch("/products/:id", requireAuth, updateSellerProduct);
router.delete("/products/:id", requireAuth, deleteSellerProduct);

export default router;