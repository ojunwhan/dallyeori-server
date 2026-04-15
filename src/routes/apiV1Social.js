import { Router } from 'express';
import { verifySessionToken } from '../auth/session.js';
import { searchUsersDiscovery, createFriendRequest, getRecentOpponents } from '../db/friendStore.js';
import { insertRaceResult } from '../db/raceResultStore.js';

/**
 * @param {() => Set<string>} getOnlineUids
 */
export default function createApiV1SocialRouter(getOnlineUids) {
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

  router.get('/users/search', requireUserJwt, (req, res) => {
    try {
      const me = req.authUser.uid;
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const countryCode = typeof req.query.countryCode === 'string' ? req.query.countryCode : '';
      const gender = typeof req.query.gender === 'string' ? req.query.gender : '';
      const offset = req.query.offset;
      const limit = req.query.limit;
      const online = getOnlineUids();
      const { users } = searchUsersDiscovery(me, {
        q,
        countryCode,
        gender,
        offset,
        limit,
        onlineUids: online,
      });
      res.json(users);
    } catch (e) {
      console.warn('[api/v1/users/search]', e);
      res.status(500).json({ error: 'server_error' });
    }
  });

  router.post('/race/result', requireUserJwt, (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const ins = insertRaceResult(req.authUser.uid, body);
      if (!ins.ok) {
        res.status(400).json({ error: ins.error || 'bad_request' });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      console.warn('[api/v1/race/result]', e);
      res.status(500).json({ error: 'server_error' });
    }
  });

  router.get('/friends/recent-opponents', requireUserJwt, (req, res) => {
    try {
      const me = req.authUser.uid;
      const online = getOnlineUids();
      const users = getRecentOpponents(me, online);
      res.json(users);
    } catch (e) {
      console.warn('[api/v1/friends/recent-opponents]', e);
      res.status(500).json({ error: 'server_error' });
    }
  });

  router.post('/friends/request/:uid', requireUserJwt, (req, res) => {
    try {
      const target =
        req.params && typeof req.params.uid === 'string' ? req.params.uid.trim() : '';
      if (!target) {
        res.status(400).json({ error: 'bad_uid' });
        return;
      }
      const r = createFriendRequest(req.authUser.uid, target);
      if (!r.ok) {
        if (r.error === 'incoming_pending') {
          res.status(409).json({ error: r.error });
          return;
        }
        res.status(400).json({ error: r.error || 'bad_request' });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      console.warn('[api/v1/friends/request]', e);
      res.status(500).json({ error: 'server_error' });
    }
  });

  return router;
}
