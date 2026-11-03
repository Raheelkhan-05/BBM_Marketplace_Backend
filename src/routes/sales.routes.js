// routes/sales.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireSalesperson } from "../middleware/requireSalesperson.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import salesActivityLogger from "../middleware/salesActivityLogger.js";
import {
    getSummary, listMyCustomers, lookupCustomer, addCustomer,
    addCustomerContact, updateCustomerContact, deleteCustomerContact,
} from "../controllers/sales.controller.js";
import { listSalesEnquiries, createSalesEnquiry, updateSalesEnquiry, closeSalesEnquiry } from "../controllers/salesEnquiries.controller.js";
import { gstAddress } from "../controllers/orderBook.controller.js";
import salesThreadRoutes from "./salesThreads.routes.js";
import orderBookSalesRoutes from "./orderBookSales.routes.js";

const router = Router();
// The logger records each successful salesperson write for the admin's Sales monitor.
router.use(requireAuth, requireSalesperson, salesActivityLogger);
router.get("/summary", getSummary);
router.get("/customers", listMyCustomers);
router.post("/customers/lookup", lookupCustomer);
router.post("/customers", authWriteLimiter, addCustomer);

// Several contacts per customer (name optional; a mobile number or an email is required).
router.post("/customers/:id/contacts", authWriteLimiter, addCustomerContact);
router.patch("/customers/:id/contacts/:contactId", authWriteLimiter, updateCustomerContact);
router.delete("/customers/:id/contacts/:contactId", authWriteLimiter, deleteCustomerContact);

// Full buyer address from a GST number (used by the Punch order sheet).
router.post("/gst-address", authWriteLimiter, gstAddress);

router.get("/enquiries", listSalesEnquiries);
router.post("/enquiries", authWriteLimiter, createSalesEnquiry);
router.patch("/enquiries/:id", authWriteLimiter, updateSalesEnquiry);
router.post("/enquiries/:id/close", authWriteLimiter, closeSalesEnquiry);

router.use("/threads", salesThreadRoutes);
router.use("/order-book", orderBookSalesRoutes);
export default router;