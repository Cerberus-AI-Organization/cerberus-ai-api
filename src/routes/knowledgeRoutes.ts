import { Router } from "express";
import { authenticateToken } from "../middleware/authMiddleware";
import { requireAdmin } from "../middleware/requireAdmin";
import { getKnowledge, searchKnowledge } from "../controllers/knowledgeController";

const router = Router();

router.use(authenticateToken);

router.get("/", requireAdmin, getKnowledge);
router.post("/", searchKnowledge);

export default router;
