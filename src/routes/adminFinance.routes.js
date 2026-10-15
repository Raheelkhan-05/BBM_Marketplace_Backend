// routes/adminFinance.routes.js
// Admin Finance & Payments routes.
// All endpoints are read-only and must be accessible only to admins.

import express from "express";

import {
    getFinanceOverview,
    getPendingPayouts,
    listFinanceTransactions,
    exportFinanceCsv,
    getFinanceTransactionDetail,
    getFinanceHealth,
} from "../controllers/adminFinance.controller.js";

import { requireAuth } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";

const router = express.Router();

// Protect every finance endpoint with authentication and admin authorization.
router.use(requireAuth);
router.use(requireAdmin);

// Finance overview and time-series aggregation
router.get("/overview", getFinanceOverview);

// Unified transaction listing
router.get("/transactions", listFinanceTransactions);

// Export filtered transactions as CSV
router.get("/export.csv", exportFinanceCsv);

// Pending seller payouts and held settlements
router.get("/pending-payouts", getPendingPayouts);

// Financial reconciliation and audit checks
router.get("/health", getFinanceHealth);

// Full audit trail for a specific transaction
router.get(
    "/transactions/:kind/:id",
    getFinanceTransactionDetail
);

export default router;