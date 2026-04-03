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
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const app = express();
app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: true,
  }),
);
app.use(express.json());
app.use('/api/auth', authRoutes);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const matchmaker = new Matchmaker(io);
const qrMatch = new QrMatchManager(io, matchmaker);

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
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
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

  socket.on('disconnect', () => {
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
