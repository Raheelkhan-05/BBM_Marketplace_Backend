// src/routes/salesMonitor.routes.js   (mount: app.use("/api/sales-monitor", salesMonitorRoutes))
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { getPeople, getFeed, getThreadView } from "../controllers/salesMonitor.controller.js";
import {
    requireSalesMonitorAdmin,
    listMonitorEnquiries,
    listMonitorOrders,
} from "../controllers/salesMonitorLists.controller.js";


const router = Router();
router.use(requireAuth);
router.get("/people", getPeople);
router.get("/feed", getFeed);
router.get("/threads/:id", getThreadView);
// Full-page enquiry and order lists.
// Both endpoints are restricted to company admins.

router.get(
    "/enquiries",
    requireSalesMonitorAdmin,
    listMonitorEnquiries
);

router.get(
    "/orders",
    requireSalesMonitorAdmin,
    listMonitorOrders
);
export default router;