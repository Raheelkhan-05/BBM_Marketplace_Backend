import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import {
    listSellerOrders, getSellerOrder, confirmOrder, rejectOrder, shipOrder, deliverOrder,
    getOwnTransportOptions,
} from "../controllers/sellerOrders.controller.js";
import { getSellerDispute, sellerRespondToDispute } from "../controllers/orderDisputes.controller.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const evidenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 4 } });

const router = Router();
router.use(requireAuth, requireApprovedSeller);
router.get("/", listSellerOrders);
router.get("/transport-options", getOwnTransportOptions);
router.get("/:id", getSellerOrder);
router.get("/:id/dispute", getSellerDispute);

router.post("/:id/confirm", confirmOrder);
router.post("/:id/reject", rejectOrder);
router.post(
    "/:id/ship",
    upload.fields([{ name: "lr_proof", maxCount: 1 }, { name: "bill", maxCount: 1 }]),
    shipOrder
);
router.post("/:id/deliver", deliverOrder);
router.post("/:id/dispute/respond", evidenceUpload.array("evidence", 4), sellerRespondToDispute);
export default router;
