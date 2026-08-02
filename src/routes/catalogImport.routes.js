// backend/routes/catalogImport.routes.js
import { Router } from "express";
import { uploadMiddleware, startCatalogImport, getCatalogImportStatus } from "../controllers/catalogImport.controller.js";

const router = Router();

router.post("/import", uploadMiddleware, startCatalogImport);
router.get("/import/:jobId/status", getCatalogImportStatus);

export default router;