import multer from "multer";
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { optionalAuth } from "../middleware/optionalAuth.middleware.js";
import { checkoutStatus, getOrderQuote, placeOrder, listMyOrders, getMyOrder, getOfferForResume, getOrderConstraints, getSellerTransportOptions } from "../controllers/orders.controller.js";
import { cancelMyOrder, raiseDispute, getBuyerDispute } from "../controllers/orderDisputes.controller.js";

// Payments now go through JioPay (see routes/payments.routes.js). The manual
// GET /:id/payment and POST /:id/payment-proof endpoints were removed on purpose:
// a buyer must never be able to self-report a payment.
const evidenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 4 } });

const router = Router();
router.get("/checkout-status", optionalAuth, checkoutStatus);
router.get("/quote", optionalAuth, getOrderQuote); // read-only, no PII — same exposure level as your public catalog search
router.get("/order-constraints", getOrderConstraints);
router.get("/transport-options", getSellerTransportOptions);
router.get("/offer-for-resume", requireAuth, getOfferForResume);
router.get("/", requireAuth, listMyOrders);
router.get("/:id", requireAuth, getMyOrder);
router.post("/", requireAuth, placeOrder);
router.post("/:id/cancel", requireAuth, cancelMyOrder);

router.get("/:id/dispute", requireAuth, getBuyerDispute);
router.post("/:id/dispute", requireAuth, evidenceUpload.array("evidence", 4), raiseDispute);

export default router;