// routes/wallet.routes.js
import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import {
    getWalletStatus, getWalletTransactions, submitWalletPayment, listWalletPayments,
    getWalletPaymentInstructions, // NEW
} from "../controllers/wallet.controller.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = Router();
router.use(requireAuth, requireApprovedSeller);
router.get("/", getWalletStatus);
router.get("/transactions", getWalletTransactions);
router.get("/payment-instructions", getWalletPaymentInstructions); // NEW
router.post("/payments", upload.single("screenshot"), submitWalletPayment); // NEW — now multipart
router.get("/payments", listWalletPayments);
export default router;