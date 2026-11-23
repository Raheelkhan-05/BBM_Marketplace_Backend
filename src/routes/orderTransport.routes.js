// routes/orderTransport.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import {
    getOrderTransport, proposeOrderTransport, acceptOrderTransport,
    declineOrderTransport, withdrawOrderTransport, summaryOrderTransport,
} from "../controllers/orderTransport.controller.js";

const router = Router();
router.use(requireAuth); // buyer or seller of the order; ownership is checked in the controller

// NOTE: "/summary" must stay above "/:orderId" or it would be read as an order id.
router.get("/summary", summaryOrderTransport);
router.post("/requests/:requestId/accept", acceptOrderTransport);
router.post("/requests/:requestId/decline", declineOrderTransport);
router.post("/requests/:requestId/withdraw", withdrawOrderTransport);
router.get("/:orderId", getOrderTransport);
router.post("/:orderId/propose", proposeOrderTransport);

export default router;

// Mount in your main app file (unchanged):
//   import orderTransportRoutes from "./routes/orderTransport.routes.js";
//   app.use("/api/order-transport", orderTransportRoutes);