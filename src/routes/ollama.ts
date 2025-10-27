import { Router } from "express";
import { listModels, pullModel, deleteModel, stopModel } from "../controllers/ollamaController";
import { authenticateToken } from "../middleware/authMiddleware";

const router = Router();

router.get("/:id/models", authenticateToken, listModels);
router.post("/:id/models/pull", authenticateToken, pullModel);
router.delete("/:id/models/:name", authenticateToken, deleteModel);
router.post("/:id/stop", authenticateToken, stopModel);

export default router;