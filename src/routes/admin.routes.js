//routes/admin.routes.js

import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
  listSellers, getSellerDetail, updateSellerAsAdmin, approveSeller, rejectSeller,
  searchUsers, listAdmins, createAdmin, demoteAdmin
} from "../controllers/admin.controller.js";
import {
  listCatalogEntries, getCatalogEntry, updateCatalogEntry,
  approveCatalogEntry, rejectCatalogEntry, getMappingOptions,
  createMappingOption, createCatalogEntry, deleteCatalogEntry,
  adminListCatalog, adminCreateCatalogEntry,
  searchCatalogEverywhere,
  listUnmappedCatalogEntries, getUnmappedCatalogCounts,
  listBrands, updateBrand
} from "../controllers/adminCatalog.controller.js";
import multer from "multer";
import { downloadCatalogTemplate, bulkUploadCatalog } from "../controllers/adminCatalogBulk.controller.js";
import { uploadCatalogImage } from "../controllers/adminUpload.controller.js";
import { listPendingPaymentProofs, verifyPayment, rejectPayment } from "../controllers/paymentVerification.controller.js";
import { notifyUser, notifySellerProfileChanged } from "../services/notifications.service.js";
import adminDbRoutes from "./adminDb.routes.js";
import { downloadFullCatalogTemplate, bulkUploadFullCatalog } from "../controllers/adminCatalogFullBulk.controller.js";
import productCommissionRoutes from "./productCommission.routes.js";
import {
  adminListDisputes, adminGetDispute, adminStartReview, adminPostMessage,
  adminResolveDispute, adminListLedger, adminRunSettlementSweep,
} from "../controllers/adminDisputes.controller.js";
import { shapeUploader } from "../services/bannerImages.service.js";
import {
  adminListEntityBanners, adminUpsertEntityBanner, adminPatchEntityBanner, adminDeleteEntityBanner,
} from "../controllers/entityBanners.controller.js";
// NEW — RFQ review queue + settings.
import {
  getRfqSettings, updateRfqSettings, adminListEnquiries, adminGetEnquiry,
  adminUpdateEnquiry, adminApproveEnquiry, adminRejectEnquiry,
} from "../controllers/adminRfq.controller.js";

import { adminListGstinReports, adminResolveGstinReport } from "../controllers/gstinReport.controller.js";

// NEW — these two functions already existed in wallet.controller.js but were
// never imported/mounted here, which is why there was no admin route to
// verify wallet top-ups. Wiring them in now.
import { adminListWalletPayments, adminVerifyWalletPayment } from "../controllers/wallet.controller.js";

// NEW — bulk "map many brand items to one generic product".
import { bulkMapBrandItems } from "../controllers/adminCatalogBulkMap.controller.js";

// NEW — admin-curated 16:9 banners for product groups on the Home page.
import {
  bannerImageUpload, adminListGroupBanners, adminUpsertGroupBanner, adminPatchGroupBanner,
  adminDeleteGroupBanner, adminReorderGroupBanners, adminScanGroups,
} from "../controllers/groupBanners.controller.js";

import { aiOverview, aiEnqueue, aiCancel } from "../controllers/aiBanners.controller.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })


const router = Router();

router.use(adminDbRoutes);

router.use(productCommissionRoutes);

router.get("/sellers", requireAuth, requireAdmin, listSellers);
router.get("/catalog/search", requireAuth, requireAdmin, searchCatalogEverywhere);
router.get("/catalog/unmapped/counts", requireAuth, requireAdmin, getUnmappedCatalogCounts); // NEW — before /unmapped
router.get("/catalog/unmapped", requireAuth, requireAdmin, listUnmappedCatalogEntries); // NEW — before /:level/:id
router.get("/sellers/:id", requireAuth, requireAdmin, getSellerDetail);
router.patch("/sellers/:id", requireAuth, requireAdmin, authWriteLimiter, updateSellerAsAdmin);
router.post("/sellers/:id/approve", requireAuth, requireAdmin, authWriteLimiter, approveSeller);
router.post("/sellers/:id/reject", requireAuth, requireAdmin, authWriteLimiter, rejectSeller);

router.get("/users/search", requireAuth, requireAdmin, searchUsers);
router.get("/admins", requireAuth, requireAdmin, listAdmins);
router.post("/admins/create", requireAuth, requireAdmin, authWriteLimiter, createAdmin);
router.post("/admins/demote", requireAuth, requireAdmin, authWriteLimiter, demoteAdmin);

// router.get("/catalog", requireAuth, requireAdmin, adminListCatalog);
router.get("/brands", requireAuth, requireAdmin, listBrands);
router.patch("/brands/:brandName", requireAuth, requireAdmin, updateBrand);
router.post("/catalog", requireAuth, requireAdmin, adminCreateCatalogEntry);
router.get("/catalog", requireAuth, requireAdmin, listCatalogEntries);
router.get("/catalog/options", requireAuth, requireAdmin, getMappingOptions);
router.get("/catalog/:level/excel-template", requireAuth, requireAdmin, downloadCatalogTemplate);
router.post("/catalog/:level/excel-upload", requireAuth, requireAdmin, upload.single("file"), bulkUploadCatalog);
router.get("/catalog/:level/:id", requireAuth, requireAdmin, getCatalogEntry);
router.patch("/catalog/:level/:id", requireAuth, requireAdmin, authWriteLimiter, updateCatalogEntry);
router.post("/catalog/:level/:id/approve", requireAuth, requireAdmin, authWriteLimiter, approveCatalogEntry);
router.post("/catalog/:level/:id/reject", requireAuth, requireAdmin, authWriteLimiter, rejectCatalogEntry);
router.post("/catalog/options", requireAuth, requireAdmin, authWriteLimiter, createMappingOption);
router.post("/catalog/upload", requireAuth, requireAdmin, upload.single("file"), uploadCatalogImage);
router.delete("/catalog/:level/:id", requireAuth, requireAdmin, deleteCatalogEntry);
router.post("/catalog/:level", requireAuth, requireAdmin, authWriteLimiter, createCatalogEntry);

router.get("/payment-proofs", requireAuth, requireAdmin, listPendingPaymentProofs);
router.post("/payment-proofs/:id/verify", requireAuth, requireAdmin, authWriteLimiter, verifyPayment);
router.post("/payment-proofs/:id/reject", requireAuth, requireAdmin, authWriteLimiter, rejectPayment);

// NEW — wallet top-up (seller credit recharge) verification queue.
// Mirrors the order payment-proofs routes above, but for wallet_payments.
router.get("/wallet/payments", requireAuth, requireAdmin, adminListWalletPayments);
router.post("/wallet/payments/:id/verify", requireAuth, requireAdmin, authWriteLimiter, adminVerifyWalletPayment);

router.get("/disputes", requireAuth, requireAdmin, adminListDisputes);
router.get("/disputes/ledger", requireAuth, requireAdmin, adminListLedger);
router.post("/disputes/settlements/run", requireAuth, requireAdmin, authWriteLimiter, adminRunSettlementSweep);
router.get("/disputes/:id", requireAuth, requireAdmin, adminGetDispute);
router.post("/disputes/:id/review", requireAuth, requireAdmin, authWriteLimiter, adminStartReview);
router.post("/disputes/:id/message", requireAuth, requireAdmin, authWriteLimiter, adminPostMessage);
router.post("/disputes/:id/resolve", requireAuth, requireAdmin, authWriteLimiter, adminResolveDispute);

router.get("/gstin-reports", requireAuth, requireAdmin, adminListGstinReports);
router.post("/gstin-reports/:id/resolve", requireAuth, requireAdmin, adminResolveGstinReport);

// NEW — RFQ review. /rfq/settings MUST stay above /rfq/:id.
router.get("/rfq/settings", requireAuth, requireAdmin, getRfqSettings);
router.put("/rfq/settings", requireAuth, requireAdmin, authWriteLimiter, updateRfqSettings);
router.get("/rfq", requireAuth, requireAdmin, adminListEnquiries);
router.get("/rfq/:id", requireAuth, requireAdmin, adminGetEnquiry);
router.patch("/rfq/:id", requireAuth, requireAdmin, authWriteLimiter, adminUpdateEnquiry);
router.post("/rfq/:id/approve", requireAuth, requireAdmin, authWriteLimiter, adminApproveEnquiry);
router.post("/rfq/:id/reject", requireAuth, requireAdmin, authWriteLimiter, adminRejectEnquiry);

router.get("/catalog-bulk/excel-template", requireAuth, requireAdmin, downloadFullCatalogTemplate);
router.post("/catalog-bulk/excel-upload", requireAuth, requireAdmin, upload.single("file"), bulkUploadFullCatalog);

// NEW — map many brand items to one generic product at once.
router.post("/catalog-bulk/map-brand-items", requireAuth, requireAdmin, authWriteLimiter, bulkMapBrandItems);

// NEW — Home page group banners. /group-banners/order and /scan MUST stay above /:groupId.
router.get("/group-banners", requireAuth, requireAdmin, adminListGroupBanners);
router.put("/group-banners/order", requireAuth, requireAdmin, authWriteLimiter, adminReorderGroupBanners);
router.post("/group-banners/scan", requireAuth, requireAdmin, authWriteLimiter, adminScanGroups);
router.put("/group-banners/:groupId", requireAuth, requireAdmin, authWriteLimiter, bannerImageUpload, adminUpsertGroupBanner);
router.patch("/group-banners/:groupId", requireAuth, requireAdmin, authWriteLimiter, adminPatchGroupBanner);
router.delete("/group-banners/:groupId", requireAuth, requireAdmin, authWriteLimiter, adminDeleteGroupBanner);

// NEW — category / subcategory banners (multi-shape storage).
router.get("/entity-banners/:type", requireAuth, requireAdmin, adminListEntityBanners);
router.put("/entity-banners/:type/:id", requireAuth, requireAdmin, authWriteLimiter, shapeUploader(), adminUpsertEntityBanner);
router.patch("/entity-banners/:type/:id", requireAuth, requireAdmin, authWriteLimiter, adminPatchEntityBanner);
router.delete("/entity-banners/:type/:id", requireAuth, requireAdmin, authWriteLimiter, adminDeleteEntityBanner);
router.delete("/entity-banners/:type/:id/:shape", requireAuth, requireAdmin, authWriteLimiter, adminDeleteEntityBanner);

router.get("/ai-banners", requireAuth, requireAdmin, aiOverview);
router.post("/ai-banners/jobs", requireAuth, requireAdmin, authWriteLimiter, aiEnqueue);
router.post("/ai-banners/cancel", requireAuth, requireAdmin, authWriteLimiter, aiCancel);

export default router;