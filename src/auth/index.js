import { Router } from 'express';
import googleRoutes from './google.js';
import kakaoRoutes from './kakao.js';
import { verifySessionToken } from './session.js';
import { markProfileSetupComplete } from './userStore.js';
import { getProfile, trySaveProfileFromBody, profileToClient } from '../db/profileStore.js';

const router = Router();
router.use(googleRoutes);
router.use(kakaoRoutes);

/** 프로필 설정 완료 → 서버에 기가입 표시 (기기 간 중복 가입 방지) + 선택 시 DB 프로필 upsert */
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
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof body.nickname === 'string' && body.nickname.trim()) {
      const r = trySaveProfileFromBody(p.uid, body);
      if (r.status === 400) {
        res.status(400).json({ error: r.error });
        return;
      }
      if (r.status === 409) {
        res.status(409).json({ error: r.error });
        return;
      }
    }
    markProfileSetupComplete(p.uid);
    const saved = getProfile(p.uid);
    res.json({
      ok: true,
      isNewUser: false,
      user: { uid: p.uid, displayName: p.displayName, email: p.email, photoURL: p.photoURL },
      ...(saved ? { profile: profileToClient(saved) } : {}),
    });
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
});

export default router;
