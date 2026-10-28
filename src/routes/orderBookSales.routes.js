// routes/orderBookSales.routes.js
// Mount INSIDE the sales router (it already has requireAuth + requireSalesperson):
//   import orderBookSalesRoutes from "./orderBookSales.routes.js";
//   router.use("/order-book", orderBookSalesRoutes);        // -> /api/sales/order-book
import { Router } from "express";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import { listMine, getMine, createOrder } from "../controllers/orderBook.controller.js";

const router = Router();
router.get("/", listMine);
router.post("/", authWriteLimiter, createOrder);
router.get("/:id", getMine);
export default router;