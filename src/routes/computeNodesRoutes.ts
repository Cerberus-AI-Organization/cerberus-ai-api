import { Router } from 'express';
import { addComputeNode, updateComputeNode, getComputeNodes, deleteComputeNode } from '../controllers/computeNodeController';
import { authenticateToken } from '../middleware/authMiddleware';
import { requireAdmin } from '../middleware/requireAdmin';

const router = Router();

router.use(authenticateToken);

router.get('/', getComputeNodes);
router.post('/', requireAdmin, addComputeNode);
router.put('/:id', requireAdmin, updateComputeNode);
router.delete('/:id', requireAdmin, deleteComputeNode);

export default router;
