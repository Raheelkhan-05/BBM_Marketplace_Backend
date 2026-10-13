import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
    listCustomers, lookupCustomer, addCustomer, bulkAddCustomers, markInvited, removeCustomer,
} from "../controllers/sellerCustomers.controller.js";

const router = Router();
router.use(requireAuth, requireApprovedSeller);
router.get("/", listCustomers);
router.post("/lookup", lookupCustomer);
router.post("/", authWriteLimiter, addCustomer);
router.post("/bulk", authWriteLimiter, bulkAddCustomers);
router.post("/:id/invite", authWriteLimiter, markInvited);
router.delete("/:id", authWriteLimiter, removeCustomer);
export default router;