// routes/listingPolicyOptions.routes.js
//app.use("/api/listing-policy-options", listingPolicyOptionsRoutes);
import { Router } from "express";
import { listPolicyOptions } from "../controllers/listingPolicyOptions.controller.js";
const router = Router();
router.get("/", listPolicyOptions);
export default router;