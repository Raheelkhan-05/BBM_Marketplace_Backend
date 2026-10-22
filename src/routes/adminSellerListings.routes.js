import express from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import {
    lookupSeller, createSellerSession, stageListing, listStaged, deleteStaged, publishStagedNow,
    listDrafts, createDrafts, updateDraft, deleteDraft, clearDrafts,
} from "../controllers/adminSellerListings.controller.js";



const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get("/lookup", lookupSeller);
router.post("/session", createSellerSession);

router.get("/staged", listStaged);
router.post("/staged", stageListing);
router.post("/staged/publish", publishStagedNow);
router.delete("/staged/:id", deleteStaged);

router.get("/drafts", listDrafts);
router.post("/drafts", createDrafts);
router.delete("/drafts", clearDrafts);
router.patch("/drafts/:id", updateDraft);
router.delete("/drafts/:id", deleteDraft);

export default router;