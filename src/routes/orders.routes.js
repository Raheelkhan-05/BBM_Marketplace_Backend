// routes/orders.routes.js
import multer from "multer";
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { optionalAuth } from "../middleware/optionalAuth.middleware.js";
import { checkoutStatus, getOrderQuote, placeOrder, listMyOrders, getMyOrder, cancelMyOrder } from "../controllers/orders.controller.js";
import { getPaymentInstructions, submitPaymentProof } from "../controllers/paymentProof.controller.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });


const router = Router();
router.get("/checkout-status", optionalAuth, checkoutStatus);
router.get("/quote", getOrderQuote); // read-only, no PII — same exposure level as your public catalog search
router.get("/", requireAuth, listMyOrders);
router.get("/:id", requireAuth, getMyOrder);
router.post("/", requireAuth, placeOrder);
router.post("/:id/cancel", requireAuth, cancelMyOrder);

router.get("/:id/payment", requireAuth, getPaymentInstructions);
router.post("/:id/payment-proof", requireAuth, upload.single("screenshot"), submitPaymentProof);
export default router;