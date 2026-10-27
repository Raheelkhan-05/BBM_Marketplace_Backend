// routes/salesThreads.routes.js
// Mounted inside the sales router (inherits requireAuth + requireSalesperson).
import { Router } from "express";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
    listThreads, createThread, getThread, updateThread, setThreadStatus, setReminder,
    signAttachment, addEntry, listQuoteProducts, listCatalogProducts, sendQuote, resendQuote,
} from "../controllers/salesThreads.controller.js";

const router = Router();

router.get("/", listThreads);
router.post("/", authWriteLimiter, createThread);

// Must stay above "/:id" so "products" is never read as a thread id.
router.get("/products", listCatalogProducts);

router.get("/:id", getThread);
router.patch("/:id", authWriteLimiter, updateThread);
router.patch("/:id/status", authWriteLimiter, setThreadStatus);
router.patch("/:id/reminder", authWriteLimiter, setReminder);

router.post("/:id/attachments/sign", authWriteLimiter, signAttachment);
router.post("/:id/entries", authWriteLimiter, addEntry);

router.get("/:id/products", listQuoteProducts);
router.post("/:id/quotes", authWriteLimiter, sendQuote);
router.post("/:id/quotes/:quoteId/resend", authWriteLimiter, resendQuote);

export default router;