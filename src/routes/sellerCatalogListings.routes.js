import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller, getSellerAccessStatus } from "../middleware/requireApprovedSeller.js";
import {
    listApprovedCategories,
    listApprovedSubcategories,
    listApprovedGenericProducts,
    createSubmission,
    listMySubmissions,
    createListingForExistingBrand,
    updateSubmission,
    deleteSubmission,
    setSubmissionActive,
} from "../controllers/sellerCatalogListings.controller.js";

const router = Router();

router.get("/access-status", getSellerAccessStatus);
router.get("/categories", listApprovedCategories);
router.get("/subcategories", listApprovedSubcategories);
router.get("/generic-products", listApprovedGenericProducts);

router.post("/submissions", requireAuth, requireApprovedSeller, createSubmission);
router.get("/submissions", requireAuth, requireApprovedSeller, listMySubmissions);
router.post("/listings", requireAuth, requireApprovedSeller, createListingForExistingBrand);
router.patch("/submissions/:id", requireAuth, requireApprovedSeller, updateSubmission);
router.delete("/submissions/:id", requireAuth, requireApprovedSeller, deleteSubmission);
router.patch("/submissions/:id/active", requireAuth, requireApprovedSeller, setSubmissionActive);

export default router;