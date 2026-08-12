// routes/orders.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { optionalAuth } from "../middleware/optionalAuth.middleware.js";
import { checkoutStatus, getOrderQuote, placeOrder, listMyOrders, getMyOrder, cancelMyOrder } from "../controllers/orders.controller.js";

const router = Router();
router.get("/checkout-status", optionalAuth, checkoutStatus);
router.get("/quote", getOrderQuote); // read-only, no PII — same exposure level as your public catalog search
router.get("/", requireAuth, listMyOrders);
router.get("/:id", requireAuth, getMyOrder);
router.post("/", requireAuth, placeOrder);
router.post("/:id/cancel", requireAuth, cancelMyOrder);
export default router;