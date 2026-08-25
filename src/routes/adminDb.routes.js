// routes/adminDb.routes.js
//
// Mount this into your existing admin router, e.g. at the bottom of
// routes/admin.routes.js:
//
//   import adminDbRoutes from "./adminDb.routes.js";
//   router.use(adminDbRoutes);
//
// All routes below already require the same requireAuth/requireAdmin guard
// as the rest of your admin API.

import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/adminAuth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
    listTables, getTableSchema, listRows, getRow,
    createRow, updateRow, deleteRow, getDependentsPreview,
} from "../controllers/adminDb.controller.js";

const router = Router();

router.get("/db/tables", requireAuth, requireAdmin, listTables);
router.get("/db/tables/:table/schema", requireAuth, requireAdmin, getTableSchema);
router.get("/db/tables/:table/rows", requireAuth, requireAdmin, listRows);
router.post("/db/tables/:table/rows", requireAuth, requireAdmin, authWriteLimiter, createRow);
router.get("/db/tables/:table/rows/:id", requireAuth, requireAdmin, getRow);
router.patch("/db/tables/:table/rows/:id", requireAuth, requireAdmin, authWriteLimiter, updateRow);
router.delete("/db/tables/:table/rows/:id", requireAuth, requireAdmin, authWriteLimiter, deleteRow);
router.get("/db/tables/:table/rows/:id/dependents", requireAuth, requireAdmin, getDependentsPreview);

export default router;