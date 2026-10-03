// routes/rfq.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
    listEnquiries, getEnquiry, createEnquiry, bulkCreateEnquiries, updateOwnEnquiry, closeOwnEnquiry,
} from "../controllers/rfq.controller.js";

const router = Router();
router.use(requireAuth);

router.get("/", listEnquiries);
router.post("/", authWriteLimiter, createEnquiry);
router.post("/bulk", authWriteLimiter, bulkCreateEnquiries); // before /:id
router.get("/:id", getEnquiry);
router.patch("/:id", authWriteLimiter, updateOwnEnquiry);
router.post("/:id/close", authWriteLimiter, closeOwnEnquiry);

export default router;