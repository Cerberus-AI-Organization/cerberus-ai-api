import { Router } from "express";
import {listModels, pullModel, deleteModel, stopModel, preloadModel} from "../controllers/modelController";
import { authenticateToken } from "../middleware/authMiddleware";

const router = Router();

router.get("/:id/models", authenticateToken, listModels);
router.post("/:id/models/pull", authenticateToken, pullModel);
router.delete("/:id/models/:name", authenticateToken, deleteModel);
router.post("/:id/stop", authenticateToken, stopModel);
router.post("/:id/preload", authenticateToken, preloadModel);

export default router;