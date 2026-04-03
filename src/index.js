import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import authRoutes from './auth/index.js';
import { verifySessionToken } from './auth/session.js';
import { Matchmaker } from './game/matchmaker.js';

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
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.on('findMatch', (payload) => {
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
    matchmaker.cancel(socket.id);
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
      console.log('[server] tap ignored: bad slot', socket.id, slot);
      return;
    }
    console.log('[server] tap from', socket.id, payload);
    room.onTap(slot, foot);
  });

  socket.on('requestRematch', () => {
    socket.emit('rematchRequest', { from: socket.data.uid });
  });

  socket.on('disconnect', () => {
    matchmaker.cancel(socket.id);
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

httpServer.listen(PORT, () => {
  console.log(`[dallyeori-server] http://localhost:${PORT}`);
});
