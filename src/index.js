import 'dotenv/config';
import fs from 'node:fs';
import express from 'express';
import { UPLOADS_ROOT, UPLOADS_AVATARS_DIR } from './paths.js';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import authRoutes from './auth/index.js';
import apiV1ProfileRouter from './routes/apiV1Profile.js';
import createApiV1SocialRouter from './routes/apiV1Social.js';
import { getUserStorePath } from './auth/userStore.js';
import { verifySessionToken, signQrGuestToken } from './auth/session.js';
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
import {
  getProfile,
  trySaveProfileFromBody,
  profileToClient,
  searchByNickname,
  updateLastSeen,
} from './db/profileStore.js';
import { ensureFriendsAcceptedInDb } from './db/friendStore.js';
import {
  getRequestById,
  insertPendingRequest,
  markAccepted,
  markRejected,
} from './friendRequestsJsonStore.js';

const PORT = Number(process.env.PORT) || 3100;

/** 클라이언트/게이트웨이에서 slot 이 문자열로 올 수 있음 — 엄격 비교 실패 시 raceJoin·tap 전부 무시되던 버그 방지 */
function normalizePlayerSlot(slot) {
  const n = Number(slot);
  return n === 0 || n === 1 ? n : null;
}

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

try {
  fs.mkdirSync(UPLOADS_AVATARS_DIR, { recursive: true });
} catch (e) {
  console.warn('[dallyeori-server] uploads/avatars mkdir', e);
}

/*
 * Express로 /uploads → UPLOADS_ROOT 정적 서빙 (아바타 등).
 * nginx만 쓸 때는 동일 경로를 alias로 넘겨도 되고, 이 미들웨어는 그대로 두어도 됩니다.
 *   location /uploads/ {
 *     alias /home/ubuntu/dallyeori-server/uploads/;
 *   }
 */
app.use('/uploads', express.static(UPLOADS_ROOT));

app.use('/api/auth', authRoutes);
app.use('/api/v1', apiV1ProfileRouter);

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

/** 친구 대전 신청 대기 — key `senderUid:receiverUid` → 타임아웃 id */
const PENDING_BATTLE_MS = 15_000;
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const pendingBattleTimers = new Map();

/** @param {string} senderUid @param {string} receiverUid */
function friendBattlePendingKey(senderUid, receiverUid) {
  return `${senderUid}:${receiverUid}`;
}

/** @param {string} key */
function clearPendingFriendBattle(key) {
  const t = pendingBattleTimers.get(key);
  if (t) clearTimeout(t);
  pendingBattleTimers.delete(key);
}

/** @type {Map<string, Set<string>>} uid → socket.id (1:N 탭·기기) */
const uidToSocketIds = new Map();

app.use(
  '/api/v1',
  createApiV1SocialRouter(
    () =>
      new Set(
        [...uidToSocketIds.entries()]
          .filter(([, sockSet]) => sockSet && sockSet.size > 0)
          .map(([u]) => u),
      ),
  ),
);

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

app.post('/api/profile', requireUserJwt, (req, res) => {
  try {
    const r = trySaveProfileFromBody(req.authUser.uid, req.body);
    if (r.status === 400) {
      res.status(400).json({ error: r.error });
      return;
    }
    if (r.status === 409) {
      res.status(409).json({ error: r.error });
      return;
    }
    res.json({ success: true, profile: profileToClient(r.profile) });
  } catch (e) {
    console.warn('[api/profile POST]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/profile/:uid', requireUserJwt, (req, res) => {
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
    res.json(profileToClient(p));
  } catch (e) {
    console.warn('[api/profile/:uid]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/users/search', requireUserJwt, (req, res) => {
  try {
    const qRaw = req.query.q;
    const q = typeof qRaw === 'string' ? qRaw : '';
    const users = searchByNickname(q, req.authUser.uid, 10);
    res.json({ users });
  } catch (e) {
    console.warn('[api/users/search]', e);
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
    if (!socket.data.qrGuest) {
      const prof = getProfile(payload.uid);
      if (prof) {
        if (prof.nickname) socket.data.displayName = prof.nickname;
        if (prof.photoURL) socket.data.photoURL = prof.photoURL;
        if (prof.language) socket.data.language = prof.language;
        socket.data.selectedDuckId = prof.selectedDuckId || 'bori';
      }
    }
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

  if (!socket.data.qrGuest) {
    try {
      updateLastSeen(socket.data.uid);
    } catch (e) {
      console.warn('[socket] updateLastSeen on connect', e);
    }
    const restored = qrMatch.rebindHostSocket(socket.data.uid, socket);
    if (restored?.ok) {
      socket.emit('qrSessionRestored', {
        matchCode: restored.matchCode,
        qrUrl: restored.qrUrl,
      });
    }
  }

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

  // 클럭 동기화용 왕복 핑 — 클라가 t0를 보내면 서버 수신시각을 즉시 되돌려준다.
  // 계측(편도지연 실측) + 카운트다운 시각 보정(핑퐁)의 서버측 절반. 순수 additive, 기존 로직 무영향.
  socket.on('clockPing', (clientT, ack) => {
    if (typeof ack === 'function') ack({ c: clientT, s: Date.now() });
  });

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
    qrMatch.cancelForSocket(socket.id, true);
    matchmaker.cancel(socket.id);
  });

  socket.on('qrMatchCancel', () => {
    qrMatch.cancelForSocket(socket.id, true);
  });

  socket.on('raceJoin', (payload) => {
    const roomId = payload?.roomId;
    if (!roomId) return;
    const room = matchmaker.getRoom(roomId);
    if (!room) return;
    const slot = normalizePlayerSlot(payload?.slot);
    if (slot == null) return;
    const payloadUid =
      payload && typeof payload.uid === 'string' ? payload.uid.trim() : '';
    const authUid = socket.data?.uid;
    if (payloadUid && authUid && payloadUid !== authUid) {
      console.error('[raceJoin] uid mismatch', {
        payloadUid,
        socketUid: authUid,
        socketId: socket.id,
      });
      return;
    }
    if (payloadUid && room.slotPlayerUids && room.slotPlayerUids[slot] != null) {
      if (room.slotPlayerUids[slot] !== payloadUid) {
        console.warn('[raceJoin] uid mismatch (payload vs room slot)', socket.id);
        return;
      }
    }
    const rid = matchmaker.socketRoom.get(socket.id);
    if (rid !== roomId && !matchmaker.rebindRaceSocket(roomId, slot, socket)) {
      return;
    }
    room.playerJoined(slot);
    room.syncClient(socket);
  });

  /** 카운트다운/레이스 UI 멈춤 시 서버 상태 재요청 (모바일 이벤트 유실 복구) */
  socket.on('requestRaceSync', (payload) => {
    try {
      const roomId =
        payload && typeof payload.roomId === 'string' ? payload.roomId.trim() : '';
      if (!roomId) return;
      const room = matchmaker.getRoom(roomId);
      if (!room) return;
      const slotHint = normalizePlayerSlot(payload?.slot);
      let bound = matchmaker.socketRoom.get(socket.id) === roomId;
      if (!bound && slotHint != null) {
        bound = matchmaker.rebindRaceSocket(roomId, slotHint, socket);
      }
      if (!bound) {
        bound = matchmaker.rebindRaceSocket(roomId, 0, socket) || matchmaker.rebindRaceSocket(roomId, 1, socket);
      }
      if (!bound) return;
      room.syncClient(socket);
    } catch (e) {
      console.warn('[requestRaceSync]', e);
    }
  });

  /** 경기 엔딩 UI(경기장)에 있을 때만 한판더 수신 가능 */
  socket.on('raceEndingEntered', (payload) => {
    try {
      // 게스트도 재대전 가능(같은 상대 즉석 재대전은 무료) — 엔딩 진입 표시 허용.
      const roomId =
        payload && typeof payload.roomId === 'string' ? payload.roomId.trim() : '';
      if (!roomId) return;
      socket.data.rematchArenaRoomId = roomId;
    } catch (e) {
      console.warn('[raceEndingEntered] error', e);
    }
  });

  socket.on('raceEndingLeft', (payload) => {
    try {
      const roomId =
        payload && typeof payload.roomId === 'string' ? payload.roomId.trim() : '';
      if (!roomId || socket.data.rematchArenaRoomId === roomId) {
        socket.data.rematchArenaRoomId = null;
      }
    } catch (e) {
      console.warn('[raceEndingLeft] error', e);
    }
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
    const slot = normalizePlayerSlot(payload?.slot);
    if (slot == null) {
      console.log('[server] tap ignored: bad slot', socket.id, payload);
      return;
    }
    const rid = matchmaker.socketRoom.get(socket.id);
    if (rid !== roomId && !matchmaker.rebindRaceSocket(roomId, slot, socket)) {
      console.log('[server] tap ignored: room mismatch', { socketId: socket.id, rid, roomId });
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

  socket.on('sendBattleRequest', (payload) => {
    try {
      if (socket.data.qrGuest) return;
      const fromUid = socket.data.uid;
      const targetUid =
        payload && typeof payload.targetUid === 'string' ? payload.targetUid.trim() : '';
      if (!fromUid || !targetUid || targetUid === fromUid) return;
      const receivers = getAllSocketsByUid(targetUid).filter((s) => s.connected);
      if (receivers.length === 0) {
        socket.emit('battleRequestFailed', { reason: 'offline', targetUid });
        return;
      }
      const key = friendBattlePendingKey(fromUid, targetUid);
      clearPendingFriendBattle(key);
      const tid = setTimeout(() => {
        clearPendingFriendBattle(key);
        for (const s of getAllSocketsByUid(fromUid).filter((c) => c.connected)) {
          s.emit('battleRequestFailed', { reason: 'timeout', targetUid });
        }
      }, PENDING_BATTLE_MS);
      pendingBattleTimers.set(key, tid);
      const prof = friendRequestSenderProfile(socket);
      for (const peer of receivers) {
        peer.emit('battleRequestReceived', {
          senderUid: fromUid,
          senderName: prof.nickname,
        });
      }
    } catch (e) {
      console.warn('[sendBattleRequest] handler error', e);
    }
  });

  socket.on('acceptBattleRequest', (payload) => {
    try {
      if (socket.data.qrGuest) return;
      const accepterUid = socket.data.uid;
      const peerUid =
        payload && typeof payload.targetUid === 'string' ? payload.targetUid.trim() : '';
      if (!accepterUid || !peerUid || peerUid === accepterUid) return;
      const key = friendBattlePendingKey(peerUid, accepterUid);
      if (!pendingBattleTimers.has(key)) {
        socket.emit('battleRequestFailed', { reason: 'expired', targetUid: peerUid });
        return;
      }
      clearPendingFriendBattle(key);
      const profRaw =
        payload && typeof payload === 'object' && payload.profile && typeof payload.profile === 'object'
          ? /** @type {Record<string, unknown>} */ (payload.profile)
          : null;
      if (profRaw) {
        try {
          applyClientMatchProfile(socket, profRaw);
        } catch (e) {
          console.warn('[acceptBattleRequest] profile merge', e);
        }
      }
      const initiator = pickNewestConnectedSocket(peerUid);
      if (!initiator) {
        socket.emit('battleRequestFailed', { reason: 'peer_offline', targetUid: peerUid });
        return;
      }
      const terrain = normalizeTerrainKey('normal');
      const ok = matchmaker.pairDirectRematch(terrain, initiator, socket);
      if (!ok) {
        for (const s of getAllSocketsByUid(peerUid).filter((c) => c.connected)) {
          s.emit('battleRequestFailed', { reason: 'unavailable', targetUid: accepterUid });
        }
        for (const s of getAllSocketsByUid(accepterUid).filter((c) => c.connected)) {
          s.emit('battleRequestFailed', { reason: 'unavailable', targetUid: peerUid });
        }
        return;
      }
      for (const s of getAllSocketsByUid(peerUid).filter((c) => c.connected)) {
        s.emit('battleRequestAccepted', {});
      }
      for (const s of getAllSocketsByUid(accepterUid).filter((c) => c.connected)) {
        s.emit('battleRequestAccepted', {});
      }
    } catch (e) {
      console.warn('[acceptBattleRequest] handler error', e);
    }
  });

  socket.on('declineBattleRequest', (payload) => {
    try {
      if (socket.data.qrGuest) return;
      const accepterUid = socket.data.uid;
      const peerUid =
        payload && typeof payload.targetUid === 'string' ? payload.targetUid.trim() : '';
      if (!accepterUid || !peerUid || peerUid === accepterUid) return;
      const key = friendBattlePendingKey(peerUid, accepterUid);
      if (pendingBattleTimers.has(key)) {
        clearPendingFriendBattle(key);
        for (const s of getAllSocketsByUid(peerUid).filter((c) => c.connected)) {
          s.emit('battleRequestDeclined', { peerUid: accepterUid });
        }
      }
    } catch (e) {
      console.warn('[declineBattleRequest] handler error', e);
    }
  });

  socket.on('cancelBattleRequest', (payload) => {
    try {
      if (socket.data.qrGuest) return;
      const fromUid = socket.data.uid;
      const targetUid =
        payload && typeof payload.targetUid === 'string' ? payload.targetUid.trim() : '';
      if (!fromUid || !targetUid || targetUid === fromUid) return;
      const key = friendBattlePendingKey(fromUid, targetUid);
      if (pendingBattleTimers.has(key)) clearPendingFriendBattle(key);
    } catch (e) {
      console.warn('[cancelBattleRequest] handler error', e);
    }
  });

  socket.on('sendFriendRequest', (payload) => {
    try {
      if (socket.data.qrGuest) return;
      const targetUid =
        payload && typeof payload.targetUid === 'string' ? payload.targetUid.trim() : '';
      const requestId =
        payload && typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
      const fromUid = socket.data.uid;
      if (!fromUid || !targetUid || targetUid === fromUid || !requestId) return;
      const prof = friendRequestSenderProfile(socket);
      const toProf = getProfile(targetUid);
      const toName =
        (toProf?.nickname && String(toProf.nickname).trim()) || targetUid;
      const ins = insertPendingRequest({
        id: requestId,
        fromUid,
        toUid: targetUid,
        fromName: prof.nickname,
        toName,
        createdAt: new Date().toISOString(),
      });
      if (!ins.ok) {
        if (ins.error === 'duplicate_pending' || ins.error === 'id_exists') {
          return;
        }
        console.warn('[sendFriendRequest] persist skip', ins.error);
      }
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

  socket.on('acceptFriendRequest', (payload, ack) => {
    try {
      if (socket.data.qrGuest) {
        if (typeof ack === 'function') ack({ ok: false, error: 'forbidden' });
        return;
      }
      const accepterUid = socket.data.uid;
      const requestId =
        payload && typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
      const peerUid =
        payload && typeof payload.peerUid === 'string' ? payload.peerUid.trim() : '';

      const jsonRec = requestId ? getRequestById(requestId) : null;
      if (jsonRec && jsonRec.status === 'pending') {
        if (jsonRec.toUid !== accepterUid) {
          if (typeof ack === 'function') ack({ ok: false, error: 'forbidden' });
          return;
        }
        const ma = markAccepted(requestId, accepterUid);
        if (!ma.ok) {
          if (typeof ack === 'function') ack({ ok: false, error: ma.error });
          return;
        }
        const pe = ma.rec;
        ensureFriendsAcceptedInDb(pe.fromUid, pe.toUid);

        const senderProf = getProfile(pe.fromUid);
        const accepterProf = getProfile(accepterUid);
        const senderSockets = getAllSocketsByUid(pe.fromUid).filter((s) => s.connected);
        const ss = senderSockets[0];

        const toDisplayName =
          pe.toName ||
          accepterProf?.nickname ||
          (socket.data.displayName && String(socket.data.displayName).trim()) ||
          accepterUid;

        for (const s of getAllSocketsByUid(pe.fromUid).filter((c) => c.connected)) {
          s.emit('friendRequestAccepted', {
            requestId: pe.id,
            fromUid: pe.fromUid,
            toUid: pe.toUid,
            toName: toDisplayName,
          });
        }

        const forSender = {
          peerUid: accepterUid,
          requestId: pe.id,
          nickname:
            accepterProf?.nickname ||
            (socket.data.displayName && String(socket.data.displayName).trim()) ||
            '',
          photoURL: accepterProf?.photoURL || socket.data.photoURL || '',
          duckId: accepterProf?.selectedDuckId || socket.data.selectedDuckId || 'bori',
        };
        const forAccepter = {
          peerUid: pe.fromUid,
          requestId: pe.id,
          nickname:
            senderProf?.nickname ||
            (ss?.data?.displayName && String(ss.data.displayName).trim()) ||
            '',
          photoURL: senderProf?.photoURL || ss?.data?.photoURL || '',
          duckId: senderProf?.selectedDuckId || ss?.data?.selectedDuckId || 'bori',
        };

        const emitToUid = (uid, data) => {
          for (const s of getAllSocketsByUid(uid).filter((c) => c.connected)) {
            s.emit('friendAccepted', data);
          }
        };
        emitToUid(pe.fromUid, forSender);
        emitToUid(accepterUid, forAccepter);
        if (typeof ack === 'function') ack({ ok: true });
        return;
      }

      if (!peerUid || peerUid === accepterUid) {
        if (typeof ack === 'function') ack({ ok: false, error: 'bad_request' });
        return;
      }

      const senderProf = getProfile(peerUid);
      const accepterProf = getProfile(accepterUid);
      const senderSockets = getAllSocketsByUid(peerUid).filter((s) => s.connected);
      const ss = senderSockets[0];

      const forSender = {
        peerUid: accepterUid,
        requestId,
        nickname:
          accepterProf?.nickname ||
          (socket.data.displayName && String(socket.data.displayName).trim()) ||
          '',
        photoURL: accepterProf?.photoURL || socket.data.photoURL || '',
        duckId: accepterProf?.selectedDuckId || socket.data.selectedDuckId || 'bori',
      };
      const forAccepter = {
        peerUid,
        requestId,
        nickname:
          senderProf?.nickname ||
          (ss?.data?.displayName && String(ss.data.displayName).trim()) ||
          '',
        photoURL: senderProf?.photoURL || ss?.data?.photoURL || '',
        duckId: senderProf?.selectedDuckId || ss?.data?.selectedDuckId || 'bori',
      };

      const emitToUid = (uid, data) => {
        for (const s of getAllSocketsByUid(uid).filter((c) => c.connected)) {
          s.emit('friendAccepted', data);
        }
      };
      emitToUid(peerUid, forSender);
      emitToUid(accepterUid, forAccepter);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (e) {
      console.warn('[acceptFriendRequest] handler error', e);
      if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
    }
  });

  socket.on('rejectFriendRequest', (payload, ack) => {
    try {
      if (socket.data.qrGuest) {
        if (typeof ack === 'function') ack({ ok: false, error: 'forbidden' });
        return;
      }
      const rejecterUid = socket.data.uid;
      const requestId =
        payload && typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
      if (!rejecterUid || !requestId) {
        if (typeof ack === 'function') ack({ ok: false, error: 'bad_request' });
        return;
      }
      const mr = markRejected(requestId, rejecterUid);
      if (!mr.ok) {
        if (typeof ack === 'function') ack({ ok: false, error: mr.error });
        return;
      }
      for (const s of getAllSocketsByUid(mr.rec.fromUid).filter((c) => c.connected)) {
        s.emit('friendRequestRejected', {
          requestId: mr.rec.id,
          rejectorName: mr.rec.toName || rejecterUid,
        });
      }
      if (typeof ack === 'function') ack({ ok: true });
    } catch (e) {
      console.warn('[rejectFriendRequest] handler error', e);
      if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
    }
  });

  socket.on('sendRematch', (payload) => {
    try {
      // 게스트도 '한판 더' 요청 가능 (같은 상대 즉석 재대전은 무료; 친구·전적·랜덤매칭은 가입 필요).
      const targetUid =
        payload && typeof payload.targetUid === 'string' ? payload.targetUid : '';
      const roomId =
        payload && typeof payload.roomId === 'string' ? payload.roomId.trim() : '';
      const fromUid = socket.data.uid;
      if (!fromUid || !targetUid || targetUid === fromUid) return;
      if (!roomId) {
        socket.emit('rematchUnavailable', { reason: 'no_room' });
        return;
      }
      if (socket.data.rematchArenaRoomId !== roomId) {
        socket.emit('rematchUnavailable', { reason: 'not_in_ending' });
        return;
      }
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
      const room = matchmaker.getRoom(roomId);
      console.log('[sendRematch] room lookup', {
        roomId,
        hasRoom: !!room,
        phase: room?.phase,
        botSlot: room?.botSlot,
      });
      if (room && room.handleBotRematchFromHuman(socket, payload)) {
        console.log('[sendRematch] bot rematch handled by RaceRoom, skip peer relay');
        return;
      }
      const senderName =
        (socket.data.displayName && String(socket.data.displayName).trim()) || fromUid;
      const peers = getAllSocketsByUid(targetUid).filter((s) => s.connected);
      const eligible = peers.filter((s) => s.data.rematchArenaRoomId === roomId);
      if (eligible.length === 0) {
        socket.emit('rematchUnavailable', { reason: 'peer_left' });
        return;
      }
      for (const peer of eligible) {
        peer.emit('receiveRematch', { senderUid: fromUid, senderName });
      }
    } catch (e) {
      console.warn('[sendRematch] handler error', e);
    }
  });

  socket.on('acceptRematch', (data) => {
    try {
      // 게스트도 재대전 수락 가능 → pairDirectRematch 로 같은 상대와 새 방 생성.
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
    try {
      socket.data.rematchArenaRoomId = null;
    } catch {
      /* ignore */
    }
    if (!socket.data.qrGuest) {
      try {
        updateLastSeen(socket.data.uid);
      } catch (e) {
        console.warn('[socket] updateLastSeen on disconnect', e);
      }
    }
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

app.get('/j/:matchCode', (req, res) => {
  const { matchCode } = req.params;
  if (!qrMatch.isPendingMatch(matchCode)) {
    res
      .status(410)
      .type('html')
      .send(
        '<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><title>QR</title><body><p>만료되었거나 잘못된 QR이에요.</p></body></html>',
      );
    return;
  }
  const t = signQrGuestToken(matchCode);
  const base = qrMatch.qrClientBaseUrl();
  res.redirect(302, `${base}/?qr=${encodeURIComponent(matchCode)}&t=${encodeURIComponent(t)}`);
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
