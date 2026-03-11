import { Router } from "express";
import { authenticateToken } from "../middleware/authMiddleware";
import {createChat, getUserChats, getChatMessages, postChatMessage, deleteChat} from "../controllers/chatController";

const router = Router();

router.use(authenticateToken);

router.post("/", createChat);
router.get("/", getUserChats);
router.post("/:id/message", postChatMessage);
router.get("/:id/messages", getChatMessages);
router.delete('/:id', deleteChat);

export default router;
