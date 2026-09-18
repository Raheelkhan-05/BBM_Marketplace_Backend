import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { listCountries, listStates, listCities, searchGeo, lookupPincode, getBuyerFallbackLocation } from "../controllers/geoLocations.controller.js";

const router = Router();
router.get("/countries", listCountries);
router.get("/states", listStates);
router.get("/cities", listCities);
router.get("/search", searchGeo);
router.get("/pincode/:pincode", lookupPincode);
router.get("/buyer-fallback-location", requireAuth, getBuyerFallbackLocation);
export default router;