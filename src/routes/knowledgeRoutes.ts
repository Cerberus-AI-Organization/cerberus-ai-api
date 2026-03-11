import {Router} from "express";
import {authenticateToken} from "../middleware/authMiddleware";
import {getKnowledge, searchKnowledge} from "../controllers/knowledgeController";

const router = Router();

router.use(authenticateToken);

router.get("/", getKnowledge)
router.post("/", searchKnowledge)

export default router;