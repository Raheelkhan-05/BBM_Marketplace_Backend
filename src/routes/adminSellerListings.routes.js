// routes/adminSellerListings.routes.js
import express from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import {
    lookupSeller, createSellerSession, stageListing, listStaged, deleteStaged, publishStagedNow,
    listDrafts, createDrafts, updateDraft, deleteDraft, clearDrafts,
} from "../controllers/adminSellerListings.controller.js";
import { setListingImages, setStagedImages, setDraftImages } from "../controllers/adminListingImages.controller.js";
import { deleteDraftsBulk, deleteStagedBulk, softDeleteListings } from "../controllers/adminListingBulk.controller.js";

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get("/lookup", lookupSeller);
router.post("/session", createSellerSession);

router.get("/staged", listStaged);
router.post("/staged", stageListing);
router.post("/staged/publish", publishStagedNow);
router.post("/staged/images", setStagedImages);
router.post("/staged/delete", deleteStagedBulk);
router.delete("/staged/:id", deleteStaged);

router.get("/drafts", listDrafts);
router.post("/drafts", createDrafts);
router.post("/drafts/images", setDraftImages);
router.post("/drafts/delete", deleteDraftsBulk);
router.delete("/drafts", clearDrafts);
router.patch("/drafts/:id", updateDraft);
router.delete("/drafts/:id", deleteDraft);

router.post("/listings/images", setListingImages);
router.post("/listings/delete", softDeleteListings);

export default router;