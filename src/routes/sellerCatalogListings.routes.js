// routes/sellerCatalogListings.routes.js
//
// Replaces whichever file currently mounts the router at
// /api/seller/catalog in your app (the one that previously exported
// the routes for access-status/categories/subcategories/generic-products/
// submissions/listings). Adds the new commission-info, submission-detail,
// and templates ("groups") endpoints.

import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller, getSellerAccessStatus } from "../middleware/requireApprovedSeller.js";
import {
    listApprovedCategories,
    listApprovedSubcategories,
    listApprovedGenericProducts,
    getCommissionInfo,
    createSubmission,
    listMySubmissions,
    getSubmissionDetail,
    createListingForExistingBrand,
    updateSubmission,
    deleteSubmission,
    setSubmissionActive,
    createSellerCategory,
    createSellerSubcategory,
    createSellerGenericProduct,
} from "../controllers/sellerCatalogListings.controller.js";
import {
    listTemplates,
    listDefaultTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
} from "../controllers/sellerListingTemplates.controller.js";

const router = Router();

router.get("/access-status", getSellerAccessStatus);
router.get("/categories", listApprovedCategories);
router.get("/subcategories", listApprovedSubcategories);
router.get("/generic-products", listApprovedGenericProducts);
router.get("/commission-info", getCommissionInfo);

router.post("/categories", requireAuth, requireApprovedSeller, createSellerCategory);
router.post("/subcategories", requireAuth, requireApprovedSeller, createSellerSubcategory);
router.post("/generic-products", requireAuth, requireApprovedSeller, createSellerGenericProduct);

router.post("/submissions", requireAuth, requireApprovedSeller, createSubmission);
router.get("/submissions", requireAuth, requireApprovedSeller, listMySubmissions);
router.get("/submissions/:id", requireAuth, requireApprovedSeller, getSubmissionDetail);
router.post("/listings", requireAuth, requireApprovedSeller, createListingForExistingBrand);
router.patch("/submissions/:id", requireAuth, requireApprovedSeller, updateSubmission);
router.delete("/submissions/:id", requireAuth, requireApprovedSeller, deleteSubmission);
router.patch("/submissions/:id/active", requireAuth, requireApprovedSeller, setSubmissionActive);

router.get("/templates", requireAuth, requireApprovedSeller, listTemplates);
router.get("/templates/defaults", requireAuth, requireApprovedSeller, listDefaultTemplates);
router.post("/templates", requireAuth, requireApprovedSeller, createTemplate);
router.patch("/templates/:id", requireAuth, requireApprovedSeller, updateTemplate);
router.delete("/templates/:id", requireAuth, requireApprovedSeller, deleteTemplate);

export default router;