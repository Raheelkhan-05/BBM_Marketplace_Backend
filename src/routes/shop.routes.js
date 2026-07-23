import { Router } from "express";
import { getShopBySlug } from "../controllers/shop.controller.js";

const router = Router();
router.get("/:slug", getShopBySlug); // no auth — public storefront

export default router;