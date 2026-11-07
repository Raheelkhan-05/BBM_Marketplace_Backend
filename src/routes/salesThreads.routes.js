// routes/salesThreads.routes.js
// Mounted inside the sales router (inherits requireAuth + requireSalesperson) with '/sales' prefix.
import { Router } from "express";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import { loadSalesperson } from "../services/salespersonCopy.service.js";
import { cached } from "../services/cache.service.js";
import {
    listThreads, createThread, getThread, updateThread, setThreadStatus, setReminder, setThreadProduct,
    signAttachment, addEntry, listQuoteProducts, listCatalogProducts, sendQuote, resendQuote, unreadSummary,
} from "../controllers/salesThreads.controller.js";

const router = Router();

// The sales login only sets req.sales, so getSalesActor() had no name and saved "Salesperson".
// Look the real name up once (cached 10 min) and expose it as req.actor.
router.use(async (req, res, next) => {
    try {
        const id = req.sales?.actorId;
        if (id) {
            const me = await cached(`spn:${id}`, 600, async () => {
                const p = await loadSalesperson(id);
                return { name: p?.name || "", email: p?.email || "" };
            });
            if (me?.name) {
                req.actor = { ...(req.actor || {}), id: req.actor?.id || id, name: me.name, email: req.actor?.email || me.email || null };
            }
        }
    } catch (e) {
        console.error("[sales threads] actor name lookup failed:", e?.message || e);
    }
    next();
});

router.get("/", listThreads);
router.post("/", authWriteLimiter, createThread);

// These must stay above "/:id" so they are never read as a thread id.
router.get("/products", listCatalogProducts);
router.get("/unread-count", unreadSummary);

router.get("/:id", getThread);
router.patch("/:id", authWriteLimiter, updateThread);
router.patch("/:id/status", authWriteLimiter, setThreadStatus);
router.patch("/:id/reminder", authWriteLimiter, setReminder);
router.patch("/:id/product", authWriteLimiter, setThreadProduct);   // adds the product to a cold call (once)

router.post("/:id/attachments/sign", authWriteLimiter, signAttachment);
router.post("/:id/entries", authWriteLimiter, addEntry);

router.get("/:id/products", listQuoteProducts);
router.post("/:id/quotes", authWriteLimiter, sendQuote);
router.post("/:id/quotes/:quoteId/resend", authWriteLimiter, resendQuote);

export default router;