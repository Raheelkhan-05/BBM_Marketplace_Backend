// routes/wallet.routes.js — remove the settings PATCH route entirely
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import { getWalletStatus, getWalletTransactions, submitWalletPayment, listWalletPayments } from "../controllers/wallet.controller.js";

const router = Router();
router.use(requireAuth, requireApprovedSeller);
router.get("/", getWalletStatus);
router.get("/transactions", getWalletTransactions);
router.post("/payments", submitWalletPayment);
router.get("/payments", listWalletPayments);
export default router;