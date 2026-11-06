// src/routes/api.routes.js — mounted at /api/v1 (see app.js note)
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { apiRequestLogger } from "../middleware/apiRequestLogger.middleware.js";
import { requireApiKey } from "../middleware/apiKeyAuth.middleware.js";
import * as c from "../controllers/api.controller.js";

const router = Router();

const limiter = (max, message) =>
    rateLimit({
        windowMs: 60_000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => req.apiActor || "api-client",
        handler: (req, res) =>
            res.status(429).json({ success: false, code: "RATE_LIMITED", message, request_id: req.apiRequestId }),
    });

const readLimiter = limiter(120, "Too many requests. Max 120 requests per minute.");
const writeLimiter = limiter(30, "Too many requests. Max 30 enquiries per minute.");

const wrap = (fn) => (req, res) =>
    fn(req, res).catch((e) => {
        if (!e.status) console.error("[api]", e);
        res.status(e.status || 500).json({
            success: false,
            code: e.status ? e.code || "ERROR" : "INTERNAL_ERROR",
            message: e.status ? e.message : "Something went wrong.",
            request_id: req.apiRequestId,
        });
    });

router.use(apiRequestLogger);
router.use(requireApiKey);
router.use(readLimiter);

// Buyers + RFQ
router.get("/buyers/lookup", wrap(c.lookupBuyer));
router.post("/rfq", writeLimiter, wrap(c.createRfq));
router.get("/rfq", wrap(c.listRfq));
router.get("/rfq/:id", wrap(c.getRfq));

// Orders
router.get("/orders", wrap(c.listOrders));
router.get("/orders/:id", wrap(c.getOrder));

// Catalog
router.get("/catalog/categories", wrap(c.listCategories));
router.get("/catalog/subcategories", wrap(c.listSubcategories));
router.get("/catalog/products", wrap(c.listProducts));
router.get("/catalog/products/:id", wrap(c.getProduct));
router.get("/catalog/products/:id/sellers", wrap(c.getProductSellers));
router.get("/catalog/sellers", wrap(c.listSellers));
router.get("/catalog/brands", wrap(c.listBrands));

// Pages
router.get("/pages/slugs", wrap(c.listSlugs));
router.get("/pages/content", wrap(c.getPageContent));

router.use((req, res) =>
    res.status(404).json({ success: false, code: "NOT_FOUND", message: "Endpoint not found.", request_id: req.apiRequestId })
);

export default router;