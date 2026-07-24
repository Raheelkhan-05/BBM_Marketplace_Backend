import { Router } from "express";
import { getShopBySlug, searchShops } from "../controllers/shop.controller.js";

const router = Router();
router.get("/search", searchShops);
router.get("/:slug", getShopBySlug); // no auth — public storefront

export default router;