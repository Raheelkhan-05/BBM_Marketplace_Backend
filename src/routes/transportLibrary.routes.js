// routes/transportLibrary.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import {
    getRouteOptionsForSeller,
    getRouteSuggestions,
    proposeRouteOption,
    approveProposal,
    rejectProposal,
    listMyRouteOptions,
    listPendingProposals,
    createOwnRouteOption,
    updateOwnRouteOption,
    deleteOwnRouteOption,
    browseLibrary,
    getBuyerSellerTransportPreference,
    setBuyerSellerTransportPreference
} from "../controllers/transportLibrary.controller.js";

const router = Router();

// Public / buyer-facing
router.get("/browse", browseLibrary);
router.get("/route-options", getRouteOptionsForSeller);
router.get("/route-suggestions", getRouteSuggestions);
router.post("/propose", requireAuth, proposeRouteOption);

// Seller management (Transport Library "manage" page)
router.get("/mine", requireAuth, requireApprovedSeller, listMyRouteOptions);
router.get("/proposals", requireAuth, requireApprovedSeller, listPendingProposals);
router.post("/options", requireAuth, requireApprovedSeller, createOwnRouteOption);
router.patch("/options/:id", requireAuth, requireApprovedSeller, updateOwnRouteOption);
router.delete("/options/:id", requireAuth, requireApprovedSeller, deleteOwnRouteOption);
router.post("/proposals/:id/approve", requireAuth, requireApprovedSeller, approveProposal);
router.post("/proposals/:id/reject", requireAuth, requireApprovedSeller, rejectProposal);

router.get("/buyer-preference", requireAuth, getBuyerSellerTransportPreference);
router.post("/buyer-preference", requireAuth, setBuyerSellerTransportPreference);

export default router;

// Mount in your main app file:
//   import transportLibraryRoutes from "./routes/transportLibrary.routes.js";
//   app.use("/api/transport-library", transportLibraryRoutes);