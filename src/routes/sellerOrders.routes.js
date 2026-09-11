// routes/sellerOrders.routes.js
import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import {
    listSellerOrders, getSellerOrder, confirmOrder, rejectOrder, processOrder, shipOrder, deliverOrder,
    getOwnTransportOptions, // NEW
} from "../controllers/sellerOrders.controller.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = Router();
router.use(requireAuth, requireApprovedSeller);
router.get("/", listSellerOrders);
router.get("/transport-options", getOwnTransportOptions); // NEW
router.get("/:id", getSellerOrder);
// NEW — multipart (field "proof") since confirming now carries transport
// details + an optional proof file, not just a status flip.
router.post("/:id/confirm", upload.single("proof"), confirmOrder);
router.post("/:id/reject", rejectOrder);
router.post("/:id/process", processOrder);
router.post("/:id/ship", shipOrder);
router.post("/:id/deliver", deliverOrder);
export default router;
