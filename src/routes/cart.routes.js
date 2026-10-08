// routes/cart.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { getCart, addCartItem, updateCartItem, removeCartItem, checkoutCart } from "../controllers/cart.controller.js";

const router = Router();

router.use(requireAuth);
router.get("/", getCart);
router.post("/items", addCartItem);
router.patch("/items/:submissionId", updateCartItem);
router.delete("/items/:submissionId", removeCartItem);
router.post("/checkout", checkoutCart);

// Group payment is now started with POST /api/payments/groups/:groupId/checkout (JioPay).
// The manual payment-instructions / payment-proof endpoints were removed on purpose.

export default router;