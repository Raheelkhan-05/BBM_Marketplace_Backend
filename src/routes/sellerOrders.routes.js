// routes/sellerOrders.routes.js
import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import {
    listSellerOrders, getSellerOrder, confirmOrder, rejectOrder, shipOrder, deliverOrder,
    getOwnTransportOptions,
} from "../controllers/sellerOrders.controller.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = Router();
router.use(requireAuth, requireApprovedSeller);
router.get("/", listSellerOrders);
router.get("/transport-options", getOwnTransportOptions);
router.get("/:id", getSellerOrder);

// CHANGED: confirm no longer takes a file (transport is agreed
// pre-purchase now). ship is NEW and takes two files: the LR document
// (lr_proof) and the bill (bill) — both required, see shipOrder().
// "processing" is intentionally not routed here anymore; confirmed goes
// straight to shipped.
router.post("/:id/confirm", confirmOrder);
router.post("/:id/reject", rejectOrder);
router.post(
    "/:id/ship",
    upload.fields([{ name: "lr_proof", maxCount: 1 }, { name: "bill", maxCount: 1 }]),
    shipOrder
);
router.post("/:id/deliver", deliverOrder);
export default router;