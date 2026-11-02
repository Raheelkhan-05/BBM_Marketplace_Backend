// routes/orderBookTeam.routes.js
// Company side (admin + members, never salespeople). Mount next to the other seller routers:
//   import orderBookTeamRoutes from "./routes/orderBookTeam.routes.js";
//   app.use("/api/seller/order-book", orderBookTeamRoutes);
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireApprovedSeller } from "../middleware/requireApprovedSeller.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
    requireOrderBookTeam, listTeam, getTeam, countsTeam, processOrder, shipUpload, shipOrder, completeOrder, cancelOrder,
} from "../controllers/orderBook.controller.js";
import { listDispatchers, addDispatcher, updateDispatcher, removeDispatcher } from "../controllers/orderBookDispatchers.controller.js";

const router = Router();
router.use(requireAuth, requireApprovedSeller, requireOrderBookTeam);

router.get("/", listTeam);
router.get("/counts", countsTeam);

// Must stay above "/:id" so "dispatchers" is never read as an order id.
router.get("/dispatchers", listDispatchers);
router.post("/dispatchers", authWriteLimiter, addDispatcher);
router.patch("/dispatchers/:id", authWriteLimiter, updateDispatcher);
router.delete("/dispatchers/:id", authWriteLimiter, removeDispatcher);

router.get("/:id", getTeam);
router.post("/:id/process", authWriteLimiter, processOrder);
router.post("/:id/ship", authWriteLimiter, shipUpload, shipOrder);
router.post("/:id/complete", authWriteLimiter, completeOrder);
router.post("/:id/cancel", authWriteLimiter, cancelOrder);

export default router;