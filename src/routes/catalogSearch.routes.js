import { Router } from "express";
import {
    searchCategoriesV2,
    searchSubcategoriesV2,
    searchGenericProductsV2,
    searchBrandItemsV2,
    searchSellersForBrandItemV2,
    searchHierarchyV2,
    smartSearchV2,
    searchAutocompleteV2,
} from "../controllers/catalogHierarchySearch.controller.js";
import { browseCatalog, browseGenericProducts } from "../controllers/catalogBrowse.controller.js";
import { optionalAuthListing } from "../middleware/optionalAuthListing.middleware.js";
import { listGenericProductSellers, getPublicListingDetail, listApprovedBrandsForGenericProduct } from "../controllers/catalogGenericProductSellers.controller.js";

// New, admin-approved-only search hierarchy. Fully additive — the
// original /api/search routes (hierarchysearch.controller.js) are
// untouched and keep working exactly as before.
const router = Router();

router.get("/categories", searchCategoriesV2);
router.get("/subcategories", searchSubcategoriesV2);
router.get("/generic-products", searchGenericProductsV2);
router.get("/brand-items", searchBrandItemsV2);
router.get("/sellers", optionalAuthListing, searchSellersForBrandItemV2);
router.get("/hierarchy", searchHierarchyV2);
router.get("/browse", optionalAuthListing, browseCatalog);
router.get("/smart", smartSearchV2);
router.get("/autocomplete", searchAutocompleteV2);

router.get("/browse-products", optionalAuthListing, browseGenericProducts);
router.get("/generic-product-sellers", listGenericProductSellers);
router.get("/listing/:id", getPublicListingDetail);
router.get("/generic-products/:id/brands", listApprovedBrandsForGenericProduct);

export default router;