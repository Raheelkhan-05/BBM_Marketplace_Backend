// routes/transport.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { getTransportPreference, proposeTransport, decideTransport } from "../controllers/transport.controller.js";

const router = Router();
router.get("/preference", requireAuth, getTransportPreference);
router.post("/propose", requireAuth, proposeTransport);
router.post("/:id/decide", requireAuth, decideTransport);
export default router;