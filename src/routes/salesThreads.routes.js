// routes/salesThreads.routes.js
// Mount this INSIDE your existing sales router so it inherits the auth + salesperson guards that router already applies:
//
//   // routes/sales.routes.js  (after the existing router.use(requireAuth, <your sales guard>) line)
//   import salesThreadRoutes from "./salesThreads.routes.js";
//   router.use("/threads", salesThreadRoutes);
//
// Every handler is scoped to the calling salesperson (see getSalesActor in services/salesThreads.service.js).
import { Router } from "express";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
    listThreads, createThread, getThread, updateThread, setThreadStatus,
    signAttachment, addEntry, listQuoteProducts, sendQuote, resendQuote,
} from "../controllers/salesThreads.controller.js";

const router = Router();

router.get("/", listThreads);
router.post("/", authWriteLimiter, createThread);

router.get("/:id", getThread);
router.patch("/:id", authWriteLimiter, updateThread);
router.patch("/:id/status", authWriteLimiter, setThreadStatus);

router.post("/:id/attachments/sign", authWriteLimiter, signAttachment);
router.post("/:id/entries", authWriteLimiter, addEntry);

router.get("/:id/products", listQuoteProducts);
router.post("/:id/quotes", authWriteLimiter, sendQuote);
router.post("/:id/quotes/:quoteId/resend", authWriteLimiter, resendQuote);

export default router;