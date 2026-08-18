// routes/listingPolicyOptions.routes.js
import { Router } from "express";
import { listPolicyOptions } from "../controllers/listingPolicyOptions.controller.js";
const router = Router();
router.get("/", listPolicyOptions);
export default router;