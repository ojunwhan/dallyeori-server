import { Router } from 'express';
import googleRoutes from './google.js';
import kakaoRoutes from './kakao.js';

const router = Router();
router.use(googleRoutes);
router.use(kakaoRoutes);

export default router;
