import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { verifySessionToken } from '../auth/session.js';
import { ensureAuthUser } from '../auth/userStore.js';
import {
  getProfile,
  profileToPublicV1,
  isServerProfileComplete,
  updateProfileAvatarPhoto,
} from '../db/profileStore.js';
import { UPLOADS_AVATARS_DIR as AVATAR_DIR } from '../paths.js';

/**
 * 이전에 서버에 저장된 아바타 파일만 삭제 (OAuth URL 등은 무시)
 * @param {string} oldPhotoURL
 */
function safeUnlinkOldServerAvatar(oldPhotoURL) {
  if (typeof oldPhotoURL !== 'string' || !oldPhotoURL.startsWith('/uploads/avatars/')) return;
  const base = path.basename(oldPhotoURL);
  if (!/^[\w.-]+$/.test(base)) return;
  const full = path.join(AVATAR_DIR, base);
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch {
    /* ignore */
  }
}

/** @param {string} mime */
function extFromMimetype(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'jpg';
}

const AVATAR_ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

/**
 * mime 위조 완화: 클라이언트가 보낸 originalname 확장자 화이트리스트
 * @param {string} originalname
 */
function isAllowedAvatarOriginalExtension(originalname) {
  const ext = path.extname(typeof originalname === 'string' ? originalname : '').toLowerCase();
  return AVATAR_ALLOWED_EXT.has(ext);
}

const avatarStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    cb(null, AVATAR_DIR);
  },
  filename(req, file, cb) {
    const uid = String(req.authUser?.uid ?? 'user').replace(/[^\w-]/g, '') || 'user';
    const mime = typeof file.mimetype === 'string' ? file.mimetype : '';
    const ext = extFromMimetype(mime);
    cb(null, `${uid}_${Date.now()}.${ext}`);
  },
});

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('bad_file_type'));
  },
});

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
router.post(
  '/profile/avatar',
  requireUserJwt,
  (req, res, next) => {
    uploadAvatar.single('avatar')(req, res, (err) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ error: 'file_too_large' });
          return;
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          res.status(400).json({ error: 'avatar_required' });
          return;
        }
        if (err.code === 'LIMIT_PART_COUNT' || err.code === 'LIMIT_FIELD_KEY') {
          res.status(400).json({ error: 'upload_failed' });
          return;
        }
        console.warn('[api/v1/profile/avatar] multer', err.code, err.message);
        res.status(400).json({ error: 'upload_failed', code: err.code });
        return;
      }
      if (String(err?.message) === 'bad_file_type') {
        res.status(400).json({ error: 'bad_file_type' });
        return;
      }
      console.warn('[api/v1/profile/avatar]', err);
      res.status(400).json({ error: 'upload_failed' });
    });
  },
  (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'avatar_required' });
        return;
      }
      const uid = req.authUser.uid;
      const existing = getProfile(uid);
      if (!existing) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          /* ignore */
        }
        res.status(404).json({ error: 'no_profile' });
        return;
      }
      const origName = typeof req.file.originalname === 'string' ? req.file.originalname : '';
      if (!isAllowedAvatarOriginalExtension(origName)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          /* ignore */
        }
        res.status(400).json({ error: 'invalid_extension' });
        return;
      }
      const oldUrl = existing.photoURL || '';
      const photoURL = `/uploads/avatars/${req.file.filename}`;
      const n = updateProfileAvatarPhoto(uid, photoURL);
      if (n === 0) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          /* ignore */
        }
        res.status(404).json({ error: 'no_profile' });
        return;
      }
      safeUnlinkOldServerAvatar(oldUrl);
      res.json({ ok: true, photoURL });
    } catch (e) {
      console.warn('[api/v1/profile/avatar]', e);
      try {
        if (req.file?.path) fs.unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
      res.status(500).json({ error: 'server_error' });
    }
  },
);

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
