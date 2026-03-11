import { Router } from 'express';
import { addComputeNode, updateComputeNode, getComputeNodes, deleteComputeNode } from '../controllers/computeNodeController';
import { authenticateToken } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken);

router.get('/', getComputeNodes);
router.post('/', addComputeNode);
router.put('/:id', updateComputeNode);
router.delete('/:id', deleteComputeNode);

export default router;
