import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import authRoutes from './auth/index.js';
import { getUserStorePath } from './auth/userStore.js';
import { verifySessionToken } from './auth/session.js';
import { Matchmaker } from './game/matchmaker.js';
import { normalizeTerrainKey } from './game/physics.js';
import { QrMatchManager } from './game/qrMatch.js';
import {
  saveMessage,
  getMessages,
  getUnreadMessages,
  markAsRead,
  rowToClientMessage,
} from './db/messageStore.js';
import {
  getBalance as getHeartBalance,
  getTransactions as getHeartTransactions,
  consumeHearts,
  addHearts,
  hasSentFreeToday,
  recordFreeSend,
} from './db/heartStore.js';

const PORT = Number(process.env.PORT) || 3100;

/** @returns {string[]} */
function parseAllowedOrigins() {
  const raw = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
  return raw.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
}

const allowedOrigins = parseAllowedOrigins();

const app = express();
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) {
        cb(null, true);
        return;
      }
      if (allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use('/api/auth', authRoutes);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const matchmaker = new Matchmaker(io);
const qrMatch = new QrMatchManager(io, matchmaker);

/** @type {Map<string, Set<string>>} uid → socket.id (1:N 탭·기기) */
const uidToSocketIds = new Map();

/**
 * @param {string} uid
 * @param {string} socketId
 */
function registerUidSocket(uid, socketId) {
  if (!uid || !socketId) return;
  let set = uidToSocketIds.get(uid);
  if (!set) {
    set = new Set();
    uidToSocketIds.set(uid, set);
  }
  set.add(socketId);
}

/**
 * @param {string} uid
 * @param {string} socketId
 */
function unregisterUidSocket(uid, socketId) {
  if (!uid || !socketId) return;
  const set = uidToSocketIds.get(uid);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) uidToSocketIds.delete(uid);
}

/**
 * @param {string} toUid
 * @param {string} exceptSocketId
 * @returns {import('socket.io').Socket[]}
 */
function getPeerSocketsByUid(toUid, exceptSocketId) {
  const set = uidToSocketIds.get(toUid);
  if (!set || set.size === 0) return [];
  const out = [];
  for (const sid of set) {
    if (sid === exceptSocketId) continue;
    const s = io.sockets.sockets.get(sid);
    if (s) out.push(s);
  }
  return out;
}

/**
 * @param {string} uid
 * @returns {import('socket.io').Socket[]}
 */
function getAllSocketsByUid(uid) {
  const set = uidToSocketIds.get(uid);
  if (!set || set.size === 0) return [];
  const out = [];
  for (const sid of set) {
    const s = io.sockets.sockets.get(sid);
    if (s) out.push(s);
  }
  return out;
}

/**
 * 동일 uid 탭 다중 연결 시 가장 최근 연결 소켓 사용 (재매치 시 죽은 소켓 방지)
 * @param {string} uid
 * @returns {import('socket.io').Socket | null}
 */
function pickNewestConnectedSocket(uid) {
  const list = getAllSocketsByUid(uid).filter((s) => s.connected);
  if (list.length === 0) return null;
  let best = list[0];
  let bestT = Number(best.data.connectedAt) || 0;
  for (let i = 1; i < list.length; i += 1) {
    const s = list[i];
    const t = Number(s.data.connectedAt) || 0;
    if (t >= bestT) {
      best = s;
      bestT = t;
    }
  }
  return best;
}

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

app.get('/api/messages/unread', requireUserJwt, (req, res) => {
  try {
    const rows = getUnreadMessages(req.authUser.uid);
    res.json({ messages: rows.map(rowToClientMessage) });
  } catch (e) {
    console.warn('[api/messages/unread]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/messages/:peerUid', requireUserJwt, (req, res) => {
  try {
    const me = req.authUser.uid;
    const peerUid = req.params.peerUid;
    if (!peerUid || peerUid === me) {
      res.status(400).json({ error: 'bad peer' });
      return;
    }
    const limitRaw = req.query.limit;
    const limit =
      limitRaw != null && limitRaw !== '' ? parseInt(String(limitRaw), 10) : 50;
    const beforeRaw = req.query.beforeId;
    let beforeId = null;
    if (beforeRaw != null && beforeRaw !== '') {
      const n = parseInt(String(beforeRaw), 10);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: 'bad beforeId' });
        return;
      }
      beforeId = n;
    }
    const rows = getMessages(me, peerUid, limit, beforeId);
    res.json({ messages: rows.map(rowToClientMessage) });
  } catch (e) {
    console.warn('[api/messages/:peerUid]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/messages/read', requireUserJwt, (req, res) => {
  try {
    const peerUid =
      req.body && typeof req.body.peerUid === 'string' ? req.body.peerUid : '';
    if (!peerUid || peerUid === req.authUser.uid) {
      res.status(400).json({ error: 'peerUid required' });
      return;
    }
    const updated = markAsRead(req.authUser.uid, peerUid);
    res.json({ ok: true, updated });
  } catch (e) {
    console.warn('[api/messages/read]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/hearts', requireUserJwt, (req, res) => {
  try {
    const uid = req.authUser.uid;
    const { balance } = getHeartBalance(uid);
    const transactions = getHeartTransactions(uid, 20);
    res.json({ balance, transactions });
  } catch (e) {
    console.warn('[api/hearts]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token || typeof token !== 'string') {
      next(new Error('unauthorized'));
      return;
    }
    const payload = verifySessionToken(token);
    socket.data.uid = payload.uid;
    socket.data.displayName = payload.displayName ?? '';
    socket.data.email = payload.email ?? '';
    socket.data.photoURL = payload.photoURL ?? '';
    socket.data.qrGuest = Boolean(payload.qrGuest);
    socket.data.qrMatchCode = payload.qrMatchCode || '';
    const lang = socket.handshake.auth?.language;
    socket.data.language =
      typeof lang === 'string' && lang.trim() ? lang.trim() : 'ko';
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

/**
 * syncMatchProfile / sendRematch(profile) 공통 — socket.data.matchProfile 갱신
 * @param {import('socket.io').Socket} socket
 * @param {Record<string, unknown>} r
 */
/**
 * 친구 요청 수신 측 표시용 — JWT + syncMatchProfile 반영
 * @param {import('socket.io').Socket} socket
 */
function friendRequestSenderProfile(socket) {
  const mp = socket.data.matchProfile;
  const nickMp = mp && typeof mp.nickname === 'string' ? mp.nickname.trim() : '';
  const disp =
    socket.data.displayName && typeof socket.data.displayName === 'string'
      ? socket.data.displayName.trim()
      : '';
  const nickname = nickMp || disp || socket.data.uid || 'player';
  const photoFromMp = mp && typeof mp.photoURL === 'string' ? mp.photoURL.trim() : '';
  const photoFromData =
    socket.data.photoURL && typeof socket.data.photoURL === 'string'
      ? socket.data.photoURL.trim()
      : '';
  const photoURL = photoFromMp || photoFromData || '';
  const duckFromMp = mp && typeof mp.duckId === 'string' ? mp.duckId.trim() : '';
  const duckId = duckFromMp || 'bori';
  return { nickname, photoURL, duckId };
}

function applyClientMatchProfile(socket, r) {
  if (socket.data.qrGuest) return;
  const nickRaw = r.nickname;
  const nickname =
    typeof nickRaw === 'string' && nickRaw.trim()
      ? nickRaw.trim()
      : socket.data.displayName || '플레이어';
  const photoRaw = r.photoURL;
  const photoURL = typeof photoRaw === 'string' ? photoRaw : socket.data.photoURL || '';
  const duckRaw = r.duckId;
  const duckId = typeof duckRaw === 'string' && duckRaw.trim() ? duckRaw.trim() : 'bori';
  socket.data.matchProfile = {
    userId: socket.data.uid,
    nickname,
    photoURL,
    duckId,
    wins: Number(r.wins) || 0,
    losses: Number(r.losses) || 0,
    draws: Number(r.draws) || 0,
  };
}

io.on('connection', (socket) => {
  socket.data.connectedAt = Date.now();
  registerUidSocket(socket.data.uid, socket.id);
  console.log('[socket] uid registered', socket.data.uid, '→', socket.id);

  if (socket.data.qrGuest) {
    queueMicrotask(() => qrMatch.tryJoinGuest(socket));
  } else {
    try {
      const unreadRows = getUnreadMessages(socket.data.uid);
      if (unreadRows.length > 0) {
        socket.emit(
          'unreadMessages',
          unreadRows.map(rowToClientMessage),
        );
      }
    } catch (e) {
      console.warn('[socket] unreadMessages', e);
    }
    try {
      const hb = getHeartBalance(socket.data.uid);
      socket.emit('heartBalance', { balance: hb.balance });
    } catch (e) {
      console.warn('[socket] heartBalance', e);
    }
  }

  socket.on('syncMatchProfile', (payload) => {
    try {
      if (socket.data.qrGuest) return;
      const raw =
        payload && typeof payload === 'object'
          ? /** @type {Record<string, unknown>} */ (payload).profile ?? payload
          : null;
      if (!raw || typeof raw !== 'object') return;
      applyClientMatchProfile(socket, /** @type {Record<string, unknown>} */ (raw));
    } catch (e) {
      console.warn('[syncMatchProfile] error', e);
    }
  });

  socket.on('findMatch', (payload) => {
    if (socket.data.qrGuest) return;
    const terrain = payload?.terrain || 'normal';
    const profile = payload?.profile || {};
    matchmaker.enqueue(socket, terrain, {
      userId: socket.data.uid,
      nickname: profile.nickname || socket.data.displayName || '플레이어',
      photoURL: profile.photoURL || '',
      duckId: profile.duckId || 'bori',
      wins: profile.wins,
      losses: profile.losses,
      draws: profile.draws,
    });
  });

  socket.on('cancelMatch', () => {
    qrMatch.cancelForSocket(socket.id);
    matchmaker.cancel(socket.id);
  });

  socket.on('qrMatchCancel', () => {
    qrMatch.cancelForSocket(socket.id);
  });

  socket.on('raceJoin', (payload) => {
    const roomId = payload?.roomId;
    if (!roomId) return;
    const room = matchmaker.getRoom(roomId);
    if (!room) return;
    const rid = matchmaker.socketRoom.get(socket.id);
    if (rid !== roomId) return;
    const slot = payload?.slot;
    if (slot !== 0 && slot !== 1) return;
    room.playerJoined(slot);
    room.syncClient(socket);
  });

  socket.on('tap', (payload) => {
    const roomId = payload?.roomId;
    const foot = payload?.foot;
    if (!roomId || (foot !== 'left' && foot !== 'right')) {
      console.log('[server] tap ignored: bad payload', socket.id, payload);
      return;
    }
    const room = matchmaker.getRoom(roomId);
    if (!room) {
      console.log('[server] tap ignored: no room', socket.id, roomId);
      return;
    }
    const rid = matchmaker.socketRoom.get(socket.id);
    if (rid !== roomId) {
      console.log('[server] tap ignored: room mismatch', { socketId: socket.id, rid, roomId });
      return;
    }
    const slot = payload?.slot;
    if (slot !== 0 && slot !== 1) {
      console.log('[server] tap ignored: bad slot', socket.id, payload);
      return;
    }
    room.onTap(slot, foot);
  });

  // ──── 채팅 (기존 핸들러 아래에 추가) ────
  socket.on('sendChat', async (payload) => {
    try {
      if (!payload || typeof payload.toUid !== 'string' || typeof payload.text !== 'string') return;
      const fromUid = socket.data.uid;
      if (!fromUid) return;

      const peerSockets = getPeerSocketsByUid(payload.toUid, socket.id);
      /** 번역용: 수신 측 언어 샘플 (동일 uid 탭들은 같은 language 가정) */
      const peerSocket = peerSockets[0] ?? null;

      const fromLang = socket.data.language || 'ko';
      const toLang = peerSocket?.data?.language || 'ko';

      if (peerSockets.length === 0) {
        console.log('[sendChat] no recipient sockets online for uid:', payload.toUid, {
          mapHasUid: uidToSocketIds.has(payload.toUid),
          mapSize: uidToSocketIds.get(payload.toUid)?.size ?? 0,
        });
      }
      const textSlice = String(payload.text).slice(0, 2000);

      let translatedText = payload.translatedText
        ? String(payload.translatedText).slice(0, 2000)
        : undefined;

      if (peerSocket && fromLang !== toLang) {
        translatedText = undefined;
        try {
          const res = await fetch('https://lingora.chat/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: textSlice,
              fromLang,
              toLang,
              tone: 'casual',
            }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data && typeof data.translated === 'string' && data.translated.trim()) {
              translatedText = data.translated.trim().slice(0, 2000);
            }
          } else {
            console.warn('[sendChat] translate HTTP', res.status, { fromLang, toLang });
          }
        } catch (e) {
          console.warn('[sendChat] translate error', e, { fromLang, toLang });
        }
      } else if (peerSocket) {
        console.log('[sendChat] same language, skip translate:', socket.data.language);
      }

      const saved = saveMessage({
        fromUid,
        toUid: payload.toUid,
        text: textSlice,
        translatedText: translatedText ?? null,
        fromLang,
        toLang,
      });
      if (!saved) {
        console.warn('[sendChat] saveMessage failed');
        return;
      }
      const msg = rowToClientMessage(saved);

      console.log('[sendChat]', {
        from: fromUid,
        fromLang: socket.data.language,
        to: payload.toUid,
        toLang: peerSocket?.data?.language,
        text: msg.text,
      });

      if (peerSocket && fromLang !== toLang) {
        console.log('[sendChat] translated:', {
          fromLang: socket.data.language,
          toLang: peerSocket.data.language,
          original: msg.text,
          translated: translatedText,
        });
      }

      for (const peer of peerSockets) {
        peer.emit('receiveChat', msg);
        console.log('[sendChat] delivering to socketId:', peer.id, 'uid:', payload.toUid);
      }
      socket.emit('chatSent', msg);
    } catch (e) {
      console.warn('[sendChat] handler error', e);
    }
  });

  socket.on('sendFriendRequest', (payload) => {
    try {
      if (socket.data.qrGuest) return;
      const targetUid =
        payload && typeof payload.targetUid === 'string' ? payload.targetUid : '';
      const requestId =
        payload && typeof payload.requestId === 'string' ? payload.requestId : '';
      const fromUid = socket.data.uid;
      if (!fromUid || !targetUid || targetUid === fromUid || !requestId) return;
      const prof = friendRequestSenderProfile(socket);
      const receivers = getAllSocketsByUid(targetUid).filter((s) => s.connected);
      if (receivers.length === 0) {
        console.warn('[sendFriendRequest] target has no connected socket', targetUid);
      }
      for (const peer of receivers) {
        peer.emit('receiveFriendRequest', {
          senderUid: fromUid,
          senderName: prof.nickname,
          nickname: prof.nickname,
          photoURL: prof.photoURL,
          duckId: prof.duckId,
          requestId,
        });
      }
    } catch (e) {
      console.warn('[sendFriendRequest] handler error', e);
    }
  });

  socket.on('sendRematch', (payload) => {
    try {
      if (socket.data.qrGuest) return;
      const targetUid =
        payload && typeof payload.targetUid === 'string' ? payload.targetUid : '';
      const fromUid = socket.data.uid;
      if (!fromUid || !targetUid || targetUid === fromUid) return;
      const profRaw =
        payload && typeof payload === 'object' && payload.profile && typeof payload.profile === 'object'
          ? /** @type {Record<string, unknown>} */ (payload.profile)
          : null;
      if (profRaw) {
        try {
          applyClientMatchProfile(socket, profRaw);
        } catch (e) {
          console.warn('[sendRematch] profile merge', e);
        }
      }
      const senderName =
        (socket.data.displayName && String(socket.data.displayName).trim()) || fromUid;
      for (const peer of getAllSocketsByUid(targetUid)) {
        peer.emit('receiveRematch', { senderUid: fromUid, senderName });
      }
    } catch (e) {
      console.warn('[sendRematch] handler error', e);
    }
  });

  socket.on('acceptRematch', (data) => {
    try {
      if (socket.data.qrGuest) return;
      const peerUid = data && typeof data.peerUid === 'string' ? data.peerUid : '';
      const accepterUid = socket.data.uid;
      if (!peerUid || peerUid === accepterUid) return;
      const profRaw =
        data && typeof data === 'object' && data.profile && typeof data.profile === 'object'
          ? /** @type {Record<string, unknown>} */ (data.profile)
          : null;
      if (profRaw) {
        try {
          applyClientMatchProfile(socket, profRaw);
        } catch (e) {
          console.warn('[acceptRematch] profile merge', e);
        }
      }
      const terrainRaw = data && typeof data.terrain === 'string' ? data.terrain : 'normal';
      const terrain = normalizeTerrainKey(terrainRaw);
      if (!socket.connected) {
        console.warn('[acceptRematch] skip: accepter not connected');
        return;
      }
      const initiator = pickNewestConnectedSocket(peerUid);
      if (!initiator) {
        console.warn('[acceptRematch] skip: initiator offline', peerUid);
        return;
      }
      const ok = matchmaker.pairDirectRematch(terrain, initiator, socket);
      if (!ok) console.warn('[acceptRematch] pairDirectRematch failed');
    } catch (e) {
      console.warn('[acceptRematch] handler error', e);
    }
  });

  socket.on('sendHeart', (payload) => {
    try {
      if (socket.data.qrGuest) return;
      const targetUid = payload && typeof payload.targetUid === 'string' ? payload.targetUid : '';
      const fromUid = socket.data.uid;
      if (!fromUid || !targetUid || targetUid === fromUid) return;

      const senderName =
        (socket.data.displayName && String(socket.data.displayName).trim()) || fromUid;
      const receivers = getAllSocketsByUid(targetUid);
      const senderSockets = getAllSocketsByUid(fromUid);

      /** @type {boolean} */
      let free = false;
      if (!hasSentFreeToday(fromUid, targetUid) && recordFreeSend(fromUid, targetUid)) {
        free = true;
        addHearts(targetUid, 1, 'gift_free', fromUid);
      } else {
        const spent = consumeHearts(fromUid, 1, 'gift_paid', targetUid);
        if (!spent.success) {
          socket.emit('heartError', { reason: 'noHearts', targetUid });
          return;
        }
        addHearts(targetUid, 1, 'gift_receive', fromUid);
      }

      for (const peer of receivers) {
        peer.emit('receiveHeart', { senderUid: fromUid, senderName, free });
      }
      if (receivers.length === 0) {
        console.log('[sendHeart] recipient offline', { to: targetUid, from: fromUid });
      }

      for (const s of senderSockets) {
        try {
          s.emit('heartGiftSent', { free, targetUid });
        } catch {
          /* ignore */
        }
      }

      try {
        const fromBal = getHeartBalance(fromUid).balance;
        for (const s of senderSockets) {
          try {
            s.emit('heartBalance', { balance: fromBal });
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
      const toBal = getHeartBalance(targetUid).balance;
      for (const peer of receivers) {
        try {
          peer.emit('heartBalance', { balance: toBal });
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      console.warn('[sendHeart] handler error', e);
    }
  });

  socket.on('disconnect', () => {
    unregisterUidSocket(socket.data.uid, socket.id);
    console.log('[socket] uid unregistered', socket.data.uid, '←', socket.id);
    qrMatch.onDisconnect(socket);
    matchmaker.cancel(socket.id);
  });
});

app.post('/api/qr-match/create', requireUserJwt, (req, res) => {
  const r = qrMatch.createPending(req.authUser, req.body);
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json({
    matchCode: r.matchCode,
    qrUrl: r.qrUrl,
    guestToken: r.guestToken,
  });
});

app.get('/qr/:matchCode', (req, res) => {
  const { matchCode } = req.params;
  const t = req.query.t;
  if (!t || typeof t !== 'string') {
    res.status(400).send('missing token');
    return;
  }
  try {
    const p = verifySessionToken(t);
    if (!p.qrGuest || String(p.qrMatchCode) !== matchCode) {
      res.status(403).send('invalid token');
      return;
    }
  } catch {
    res.status(403).send('invalid token');
    return;
  }
  const base = qrMatch.qrClientBaseUrl();
  res.redirect(302, `${base}/?qr=${encodeURIComponent(matchCode)}&t=${encodeURIComponent(t)}`);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

httpServer.listen(PORT, () => {
  console.log(`[dallyeori-server] http://localhost:${PORT}`);
  console.log('[dallyeori-server] 유저 저장소는 MONO(lingora)와 분리된 로컬 파일:', getUserStorePath());
});
