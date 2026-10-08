// routes/wallet.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import { getWalletStatus, getWalletTransactions, listWalletPayments } from "../controllers/wallet.controller.js";

const router = Router();
router.use(requireAuth, requireApprovedSeller);
router.get("/", getWalletStatus);
router.get("/transactions", getWalletTransactions);
// Top-ups are paid through JioPay: POST /api/payments/wallet/checkout. The old manual
// GET /payment-instructions and POST /payments (self-reported UTR) were removed on purpose.
router.get("/payments", listWalletPayments);
export default router;