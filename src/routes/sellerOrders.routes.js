// routes/sellerOrders.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import { listSellerOrders, getSellerOrder, confirmOrder, rejectOrder, processOrder, shipOrder, deliverOrder } from "../controllers/sellerOrders.controller.js";

const router = Router();
router.use(requireAuth, requireApprovedSeller);
router.get("/", listSellerOrders);
router.get("/:id", getSellerOrder);
router.post("/:id/confirm", confirmOrder);
router.post("/:id/reject", rejectOrder);
router.post("/:id/process", processOrder);
router.post("/:id/ship", shipOrder);
router.post("/:id/deliver", deliverOrder);
export default router;