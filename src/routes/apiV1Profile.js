import { Router } from 'express';
import { verifySessionToken } from '../auth/session.js';
import { ensureAuthUser } from '../auth/userStore.js';
import {
  getProfile,
  profileToPublicV1,
  isServerProfileComplete,
} from '../db/profileStore.js';

const router = Router();

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requireUserJwt(req, res, next) {
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
    req.authUser = p;
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}

/** 반드시 /profile/:uid 보다 먼저 등록 (me가 :uid에 매칭되지 않도록) */
router.get('/profile/me', requireUserJwt, (req, res) => {
  try {
    const uid = req.authUser.uid;
    const { record } = ensureAuthUser(uid);
    const p = getProfile(uid);
    if (!p) {
      res.json({
        uid,
        nickname: '',
        photoURL: typeof req.authUser.photoURL === 'string' ? req.authUser.photoURL : '',
        selectedDuckId: 'bori',
        countryCode: '',
        gender: null,
        bio: null,
        language: 'ko',
        lastSeenAt: null,
        profileSetupComplete: Boolean(record.profileSetupComplete),
        serverProfileComplete: false,
      });
      return;
    }
    res.json({
      ...profileToPublicV1(p),
      profileSetupComplete: Boolean(record.profileSetupComplete),
      serverProfileComplete: isServerProfileComplete(uid),
    });
  } catch (e) {
    console.warn('[api/v1/profile/me]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

router.get('/profile/:uid', requireUserJwt, (req, res) => {
  try {
    const targetUid =
      req.params && typeof req.params.uid === 'string' ? req.params.uid.trim() : '';
    if (!targetUid) {
      res.status(400).json({ error: 'bad uid' });
      return;
    }
    const p = getProfile(targetUid);
    if (!p) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(profileToPublicV1(p));
  } catch (e) {
    console.warn('[api/v1/profile/:uid]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
