// mount: app.use("/api/seller/gst-access", gstAccessRoutes);
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
    lookup, listingPending, listingAddBuyer, listingRemoveBuyer,
    customerList, customerSave, customerDeleteOne, customerBulkClear,
} from "../controllers/gstAccess.controller.js";

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error("[gst access]", e?.message || e);
    if (!res.headersSent) res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
});

const router = Router();
router.use(requireAuth, requireApprovedSeller);

router.post("/lookup", authWriteLimiter, wrap(lookup));
router.get("/listing/:submissionId", wrap(listingPending));
router.post("/listing/:submissionId/buyer", authWriteLimiter, wrap(listingAddBuyer));
router.delete("/listing/:submissionId/buyer/:gstin", authWriteLimiter, wrap(listingRemoveBuyer));

router.get("/customer/:gstin/pricing", wrap(customerList));
router.post("/customer/:gstin/pricing", authWriteLimiter, wrap(customerSave));
router.post("/customer/:gstin/pricing/bulk-clear", authWriteLimiter, wrap(customerBulkClear));
router.delete("/customer/:gstin/pricing/:submissionId", authWriteLimiter, wrap(customerDeleteOne));

export default router;