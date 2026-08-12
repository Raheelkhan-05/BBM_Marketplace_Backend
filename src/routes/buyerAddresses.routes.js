// routes/buyerAddresses.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { listAddresses, createAddress, updateAddress, deleteAddress, setDefaultAddress } from "../controllers/buyerAddresses.controller.js";

const router = Router();
router.use(requireAuth);
router.get("/", listAddresses);
router.post("/", createAddress);
router.patch("/:id", updateAddress);
router.delete("/:id", deleteAddress);
router.post("/:id/default", setDefaultAddress);
export default router;