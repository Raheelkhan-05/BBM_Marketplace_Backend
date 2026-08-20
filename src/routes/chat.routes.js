// routes/chat.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import {
    listConversations, getOrCreateDirectConversation,
    listMessages, sendMessage, markDelivered, markRead,
    searchChatUsers, deleteMessage
} from "../controllers/chat.controller.js";

const router = Router();

router.get("/conversations", requireAuth, listConversations);
router.post("/conversations/direct", requireAuth, getOrCreateDirectConversation);
router.get("/conversations/:conversationId/messages", requireAuth, listMessages);
router.post("/conversations/:conversationId/messages", requireAuth, sendMessage);
router.post("/conversations/:conversationId/delivered", requireAuth, markDelivered);
router.post("/conversations/:conversationId/read", requireAuth, markRead);
router.get("/users/search", requireAuth, searchChatUsers);
router.delete("/conversations/:conversationId/messages/:messageId", requireAuth, deleteMessage);

export default router;