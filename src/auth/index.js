import { Router } from 'express';
import googleRoutes from './google.js';
import kakaoRoutes from './kakao.js';
import { verifySessionToken } from './session.js';
import { markProfileSetupComplete } from './userStore.js';

const router = Router();
router.use(googleRoutes);
router.use(kakaoRoutes);

/** 프로필 설정 완료 → 서버에 기가입 표시 (기기 간 중복 가입 방지) */
router.post('/complete-profile', (req, res) => {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const p = verifySessionToken(h.slice(7));
    if (p.qrGuest) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    markProfileSetupComplete(p.uid);
    res.json({
      ok: true,
      isNewUser: false,
      user: { uid: p.uid, displayName: p.displayName, email: p.email, photoURL: p.photoURL },
    });
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
});

export default router;
