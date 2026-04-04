import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import authRoutes from './auth/index.js';
import { verifySessionToken } from './auth/session.js';
import { Matchmaker } from './game/matchmaker.js';
import { QrMatchManager } from './game/qrMatch.js';

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

io.on('connection', (socket) => {
  registerUidSocket(socket.data.uid, socket.id);
  console.log('[socket] uid registered', socket.data.uid, '→', socket.id);

  if (socket.data.qrGuest) {
    queueMicrotask(() => qrMatch.tryJoinGuest(socket));
  }

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
    console.log('[server] tap from', socket.id, payload);
    room.onTap(slot, foot);
  });

  socket.on('requestRematch', () => {
    if (socket.data.qrGuest) return;
    socket.emit('rematchRequest', { from: socket.data.uid });
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

      const msg = {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        fromId: fromUid,
        toId: payload.toUid,
        text: textSlice,
        originalText: textSlice,
        translatedText,
        ts: Date.now(),
      };

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
});
