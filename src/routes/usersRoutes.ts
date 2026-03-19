import { Router } from 'express';
import {getUsers, addUser, updateUser, deleteUser, getUser, updateUserPassword} from '../controllers/userController';
import { authenticateToken } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken);

router.get('/', getUsers);
router.get('/:id', getUser);
router.post('/', addUser);
router.put('/:id', updateUser);
router.put('/:id/password', updateUserPassword);
router.delete('/:id', deleteUser);

export default router;
