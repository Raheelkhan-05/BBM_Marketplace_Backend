// src/routes/salesChat.routes.js   (mount: app.use("/api/sales-chat", salesChatRoutes))
// Open to any signed-in person; the controller decides per thread (salesperson of the thread, company admin, or participant).
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authWriteLimiter } from "../middleware/rateLimiter.js";
import {
    getUnread, listInbox, getThread, getParticipants, getCandidates, postMessage, markThreadRead,
    addParticipant, removeParticipant, signAttachment,
} from "../controllers/salesChat.controller.js";

const router = Router();
router.use(requireAuth);

router.get("/unread", getUnread);
router.get("/threads", listInbox);
router.get("/threads/:id", getThread);
router.get("/threads/:id/participants", getParticipants);
router.get("/threads/:id/candidates", getCandidates);

router.post("/threads/:id/messages", authWriteLimiter, postMessage);
router.post("/threads/:id/read", markThreadRead);
router.post("/threads/:id/participants", authWriteLimiter, addParticipant);
router.delete("/threads/:id/participants/:userId", authWriteLimiter, removeParticipant);
router.post("/threads/:id/attachments/sign", authWriteLimiter, signAttachment);

export default router;