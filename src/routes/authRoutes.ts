import { Router } from 'express';
import { login, loginWithToken } from '../controllers/authController';
import { authenticateToken } from '../middleware/authMiddleware';

const router = Router();

router.post('/login', login);
router.get('/me', authenticateToken, loginWithToken);

export default router;
