// routes/rfq.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
    listEnquiries, getEnquiry, createEnquiry, bulkCreateEnquiries, updateOwnEnquiry, closeOwnEnquiry,
} from "../controllers/rfq.controller.js";
import { getQuoteOptions, submitQuote, withdrawQuote, listEnquiryQuotes } from "../controllers/rfqQuote.controller.js";

const router = Router();
router.use(requireAuth);

// Sets req.sellerId for approved sellers but never blocks anyone (buyers use these same GET routes).
const softSeller = (req, res, next) => {
    let done = false;
    const go = () => { if (!done) { done = true; next(); } };
    const probe = { status: () => probe, json: () => { go(); return probe; }, send: () => { go(); return probe; }, end: () => { go(); return probe; }, set: () => probe, setHeader: () => probe };
    try { Promise.resolve(requireApprovedSeller(req, probe, go)).catch(go); } catch { go(); }
};

router.get("/", softSeller, listEnquiries);
router.get("/:id", softSeller, getEnquiry);
router.get("/:id/quotes", softSeller, listEnquiryQuotes);
router.post("/", authWriteLimiter, createEnquiry);
router.post("/bulk", authWriteLimiter, bulkCreateEnquiries); // before /:id
router.patch("/:id", authWriteLimiter, updateOwnEnquiry);
router.post("/:id/close", authWriteLimiter, closeOwnEnquiry);


// Seller quotes
router.get("/:id/quote-options", requireApprovedSeller, getQuoteOptions);
router.post("/:id/quotes", authWriteLimiter, requireApprovedSeller, submitQuote);
router.post("/:id/quotes/withdraw", authWriteLimiter, requireApprovedSeller, withdrawQuote);

export default router;