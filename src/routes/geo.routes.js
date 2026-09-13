import { Router } from "express";
import {
    listCountries,
    listStates,
    listDistricts,
    listAreas,
    listVillages,
    searchGeo,
    lookupPincode,
} from "../controllers/geoLocations.controller.js";

const router = Router();
router.get("/countries", listCountries);
router.get("/states", listStates);
router.get("/districts", listDistricts);
router.get("/areas", listAreas);
router.get("/villages", listVillages);
router.get("/search", searchGeo);
router.get("/pincode/:pincode", lookupPincode);
export default router;