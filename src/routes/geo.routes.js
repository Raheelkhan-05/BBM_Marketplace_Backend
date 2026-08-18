import { Router } from "express";
import { listCountries, listStates, listCities, searchGeo, lookupPincode } from "../controllers/geoLocations.controller.js";

const router = Router();
router.get("/countries", listCountries);
router.get("/states", listStates);
router.get("/cities", listCities);
router.get("/search", searchGeo);
router.get("/pincode/:pincode", lookupPincode);
export default router;