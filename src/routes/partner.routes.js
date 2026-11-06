// src/routes/partner.routes.js   (mounted at /api/partner in app.js)
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { partnerRequestLogger } from "../middleware/partnerRequestLogger.middleware.js";
import { requirePartnerToken, requirePartnerBuyer } from "../middleware/partnerAuth.middleware.js";
import {
    ping, listRfq, getRfq, createRfq, bulkCreateRfq, updateRfq, closeRfq, rfqUpdates, ssrMeta, slugs, brandFamily,
} from "../controllers/partner.controller.js";
import {
    getBrandItemsFeed, getBrandItemDetail, getBrandItemSellers, getBrandItemSellerOffer,
    getBrandsPage, getSellersPage, getShopPublicInfo, getLowestPriceForBrandItem,
    getCategoryGenericProducts, getGenericProductBrands,
} from "../controllers/catalog.controller.js";
import { getGroupBanners } from "../controllers/groupBanners.controller.js";
import {
    searchCategoriesV2, searchSubcategoriesV2, searchGenericProductsV2, searchBrandItemsV2,
    searchAutocompleteV2, searchProductsMergedV2,
} from "../controllers/catalogHierarchySearch.controller.js";
import { browseCatalog, browseGenericProducts } from "../controllers/catalogBrowse.controller.js";
import { listPolicyOptions } from "../controllers/listingPolicyOptions.controller.js";
import { listCountries, listStates, listCities, lookupPincode } from "../controllers/geoLocations.controller.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const limiter = (max, text) => rateLimit({
    windowMs: 60_000, max, standardHeaders: true, legacyHeaders: false,
    message: { success: false, message: text },
});
const readLimiter = limiter(Number(process.env.PARTNER_RATE_LIMIT) || 120, "Too many requests. Max 120 requests per minute.");
const writeLimiter = limiter(30, "Too many write requests. Max 30 per minute.");

// Any thrown error becomes a clean { success:false, message, request_id } — internals are never leaked.
const safe = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((e) => {
        console.error("[partner]", e);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: "Something went wrong.", request_id: req.partnerRequestId });
        }
    });

// Hard cap on page size so bulk paging can't hammer the database.
const capPaging = (max = 50) => (req, res, next) => {
    if (req.query.limit !== undefined) {
        const n = parseInt(req.query.limit, 10);
        req.query.limit = String(Number.isFinite(n) && n > 0 ? Math.min(n, max) : max);
    }
    next();
};
const uuidParam = (name) => (req, res, next) =>
    UUID_RE.test(String(req.params[name]))
        ? next()
        : res.status(400).json({ success: false, message: `Invalid ${name}.`, request_id: req.partnerRequestId });

// Some reused handlers answer 5xx with raw database text. Replace it for the caller; the request log (added
// right after, so it wraps this) still records the real message.
const scrubServerErrors = (req, res, next) => {
    const orig = res.json.bind(res);
    res.json = (body) => {
        if (res.statusCode >= 500 && res.statusCode !== 503 && body && typeof body === "object") {
            body = { success: false, message: "Something went wrong.", request_id: req.partnerRequestId };
        }
        return orig(body);
    };
    next();
};

router.use(scrubServerErrors);
router.use(partnerRequestLogger);
router.use(readLimiter);
router.use(requirePartnerToken);

router.get("/ping", ping);

/* RFQ (chatbot) */
router.get("/rfq/updates", requirePartnerBuyer, safe(rfqUpdates));
router.get("/rfq", requirePartnerBuyer, safe(listRfq));
router.post("/rfq", writeLimiter, requirePartnerBuyer, safe(createRfq));
router.post("/rfq/bulk", writeLimiter, requirePartnerBuyer, safe(bulkCreateRfq));
router.get("/rfq/:id", requirePartnerBuyer, safe(getRfq));
router.patch("/rfq/:id", writeLimiter, requirePartnerBuyer, safe(updateRfq));
router.post("/rfq/:id/close", writeLimiter, requirePartnerBuyer, safe(closeRfq));

/* Catalog */
router.use("/catalog", capPaging(50));
router.get("/catalog/categories", safe(searchCategoriesV2));
router.get("/catalog/subcategories", safe(searchSubcategoriesV2));
router.get("/catalog/generic-products", safe(searchGenericProductsV2));
router.get("/catalog/categories/:categoryId/generic-products", uuidParam("categoryId"), safe(getCategoryGenericProducts));
router.get("/catalog/generic-products/:genericProductId/brands", uuidParam("genericProductId"), safe(getGenericProductBrands));
router.get("/catalog/brand-items", safe(searchBrandItemsV2));
router.get("/catalog/brand-family", safe(brandFamily));
router.get("/catalog/policy-options", safe(listPolicyOptions));
router.get("/catalog/browse", safe(browseCatalog));
router.get("/catalog/browse-products", safe(browseGenericProducts));
router.get("/catalog/autocomplete", safe(searchAutocompleteV2));
router.get("/catalog/search", safe(searchProductsMergedV2));
router.get("/catalog/brand-items-feed", safe(getBrandItemsFeed));
router.get("/catalog/brand-items/:brandItemId", uuidParam("brandItemId"), safe(getBrandItemDetail));
router.get("/catalog/brand-items/:brandItemId/sellers", uuidParam("brandItemId"), safe(getBrandItemSellers));
router.get("/catalog/brand-items/:brandItemId/seller-offer", uuidParam("brandItemId"), safe(getBrandItemSellerOffer));
router.get("/catalog/brands", safe(getBrandsPage));
router.get("/catalog/sellers", safe(getSellersPage));
router.get("/catalog/shops/:shopSlug", safe(getShopPublicInfo));
router.get("/catalog/lowest-price/:genericProductBrandId", uuidParam("genericProductBrandId"), safe(getLowestPriceForBrandItem));
router.get("/catalog/group-banners", safe(getGroupBanners));

/* Geo */
router.get("/geo/countries", safe(listCountries));
router.get("/geo/states", safe(listStates));
router.get("/geo/cities", safe(listCities));
router.get("/geo/pincode/:pincode", safe(lookupPincode));

/* Page content */
router.get("/seo/ssr-meta", safe(ssrMeta));
router.get("/seo/slugs", safe(slugs));

router.use((req, res) => res.status(404).json({ success: false, message: "Not found.", request_id: req.partnerRequestId }));

export default router;