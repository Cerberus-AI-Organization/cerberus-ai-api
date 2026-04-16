import { Router } from "express";
import { listModels, pullModel, deleteModel, stopModel, preloadModel } from "../controllers/modelController";
import { authenticateToken } from "../middleware/authMiddleware";
import { requireAdmin } from "../middleware/requireAdmin";
import { resolveNodeMiddleware } from "../middleware/resolveNode";

const router = Router();

router.get("/:id/models", authenticateToken, resolveNodeMiddleware, listModels);
router.post("/:id/models/pull", authenticateToken, requireAdmin, resolveNodeMiddleware, pullModel);
router.delete("/:id/models/:name", authenticateToken, requireAdmin, resolveNodeMiddleware, deleteModel);
router.post("/:id/stop", authenticateToken, requireAdmin, resolveNodeMiddleware, stopModel);
router.post("/:id/preload", authenticateToken, resolveNodeMiddleware, preloadModel);

export default router;
