// routes/credit.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import {
    requestCredit, decideCredit, toggleCredit, getCreditStatus,
    requestCreditIncrease, updateCreditLimit, declineCreditIncrease,
    listCreditSellers, listCreditRequests, listCreditHistory,
    searchCreditBuyers, grantCredit,
} from "../controllers/credit.controller.js";

const router = Router();

router.get("/status", requireAuth, getCreditStatus);
router.get("/sellers", requireAuth, listCreditSellers);
router.get("/incoming", requireAuth, listCreditRequests);
router.get("/history", requireAuth, listCreditHistory);
router.get("/buyers/search", requireAuth, searchCreditBuyers);

router.post("/request", requireAuth, requestCredit);
router.post("/toggle", requireAuth, toggleCredit);
router.post("/grant", requireAuth, grantCredit);
router.post("/:id/decide", requireAuth, decideCredit);
router.post("/:id/request-increase", requireAuth, requestCreditIncrease);
router.post("/:id/update-limit", requireAuth, updateCreditLimit);
router.post("/:id/decline-increase", requireAuth, declineCreditIncrease);

export default router;