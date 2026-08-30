import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { syncContacts, pendingSyncContacts, claimPendingContacts } from "../controllers/contacts.controller.js";

const router = Router();

router.post("/sync", requireAuth, syncContacts);              // logged-in direct sync
router.post("/pending-sync", pendingSyncContacts);             // public, no login needed
router.post("/claim", requireAuth, claimPendingContacts);      // logged-in, claims device's pending contacts

export default router;