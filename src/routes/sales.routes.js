import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireSalesperson } from "../middleware/requireSalesperson.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import { getSummary, listMyCustomers, lookupCustomer, addCustomer } from "../controllers/sales.controller.js";
import { listSalesEnquiries, createSalesEnquiry, updateSalesEnquiry, closeSalesEnquiry } from "../controllers/salesEnquiries.controller.js";

const router = Router();
router.use(requireAuth, requireSalesperson);
router.get("/summary", getSummary);
router.get("/customers", listMyCustomers);
router.post("/customers/lookup", lookupCustomer);
router.post("/customers", authWriteLimiter, addCustomer);

router.get("/enquiries", listSalesEnquiries);
router.post("/enquiries", authWriteLimiter, createSalesEnquiry);
router.patch("/enquiries/:id", authWriteLimiter, updateSalesEnquiry);
router.post("/enquiries/:id/close", authWriteLimiter, closeSalesEnquiry);
export default router;