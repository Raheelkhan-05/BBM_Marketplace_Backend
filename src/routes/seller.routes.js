import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
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
} from "../controllers/seller.controller.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.get("/onboarding", requireAuth, getSellerOnboarding);
router.post("/onboarding/save", requireAuth, authWriteLimiter, saveSellerOnboarding);
router.post("/onboarding/submit", requireAuth, authWriteLimiter, submitSellerOnboarding);
router.post("/upload", requireAuth, authWriteLimiter, upload.single("file"), uploadSellerFile);


// seller.routes.js
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