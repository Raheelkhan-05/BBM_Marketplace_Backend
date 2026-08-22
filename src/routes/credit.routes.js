// routes/credit.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import {
    requestCredit, decideCredit, toggleCredit, getCreditStatus
} from "../controllers/credit.controller.js";

const router = Router();

router.get("/status", requireAuth, getCreditStatus);
router.post("/request", requireAuth, requestCredit);
router.post("/:id/decide", requireAuth, decideCredit);
router.post("/toggle", requireAuth, toggleCredit);

export default router;