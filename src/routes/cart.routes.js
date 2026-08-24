// routes/cart.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { getCart, addCartItem, updateCartItem, removeCartItem, checkoutCart } from "../controllers/cart.controller.js";
import multer from "multer";
import { getGroupPaymentInstructions, submitGroupPaymentProof } from "../controllers/groupPaymentProof.controller.js";


const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(requireAuth);
router.get("/", getCart);
router.post("/items", addCartItem);
router.patch("/items/:submissionId", updateCartItem);
router.delete("/items/:submissionId", removeCartItem);
router.post("/checkout", checkoutCart);
// router.post("/groups/:groupId/payment-proof", submitGroupPaymentProof);

router.get("/groups/:groupId/payment-instructions", requireAuth, getGroupPaymentInstructions);
router.post("/groups/:groupId/payment-proof", requireAuth, upload.single("screenshot"), submitGroupPaymentProof);
export default router;