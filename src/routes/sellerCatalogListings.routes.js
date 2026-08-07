// backend/routes/sellerCatalogListings.routes.js
//
// Mount in your main router:
//   app.use("/api/seller/catalog", sellerCatalogListingsRouter);
//
// Notes vs. the previous version:
//   - No admin router to mount anymore (adminSellerListings.controller.js /
//     .routes.js can be deleted — review happens directly in Supabase now,
//     not through the app).
//   - No PATCH/DELETE on listings and no cross-track "bridge" endpoint —
//     both were part of the review/approval workflow this replaces. Add
//     them back later if you decide you need seller-side editing or a
//     merged buyer-facing view.
//   - Also remove the line that was added to search.routes.js
//     (`router.get("/products/:productId/listings", getProductListingsBridge)`)
//     — that controller export no longer exists.

import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller, getSellerAccessStatus } from "../middleware/requireApprovedSeller.js";
import {
    listApprovedCategories,
    listApprovedSubcategories,
    listApprovedProducts,
    getProductSchema,
    getListingFieldDefs,
    createListing,
    listMyListings,
} from "../controllers/sellerCatalogListings.controller.js";

const router = Router();

// Access check — never blocks, tells the frontend which screen to show
router.get("/access-status", getSellerAccessStatus);

// Approved-only pickers for the "choose a product" step
router.get("/categories", listApprovedCategories);
router.get("/subcategories", listApprovedSubcategories);
router.get("/products", listApprovedProducts);
router.get("/products/:productId/schema", getProductSchema);

// Admin-configurable generic fields (edit seller_listing_field_defs in Supabase)
router.get("/listing-fields", getListingFieldDefs);

// Listing creation — requireAuth verifies the JWT and sets req.user.id;
// requireApprovedSeller then checks that user has an approved seller_profiles row.
router.post("/listings", requireAuth, requireApprovedSeller, createListing);
router.get("/listings", requireAuth, requireApprovedSeller, listMyListings);

export default router;