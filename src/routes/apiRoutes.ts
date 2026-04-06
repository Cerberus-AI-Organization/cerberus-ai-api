import { Router } from 'express';
import {getApiInfo} from "../controllers/apiController";

const router = Router();

router.get('/', getApiInfo)

export default router;