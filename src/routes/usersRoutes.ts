import { Router } from 'express';
import { getUsers, addUser, updateUser, deleteUser, getUser, updateUserPassword } from '../controllers/userController';
import { authenticateToken } from '../middleware/authMiddleware';
import { requireAdmin } from '../middleware/requireAdmin';

const router = Router();

router.use(authenticateToken);

router.get('/', getUsers);
router.get('/:id', getUser);
router.post('/', requireAdmin, addUser);
router.put('/:id', updateUser);
router.put('/:id/password', updateUserPassword);
router.delete('/:id', requireAdmin, deleteUser);

export default router;
