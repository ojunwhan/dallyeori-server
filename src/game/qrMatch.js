import { randomBytes } from 'crypto';
import { signQrGuestToken } from '../auth/session.js';
import { normalizeTerrainKey } from './physics.js';
import { getBalance } from '../db/heartStore.js';

const QR_PENDING_MS = 180_000;
const CODE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** @param {number} len */
function randomMatchCode(len = 8) {
  const buf = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i += 1) s += CODE_CHARS[buf[i] % CODE_CHARS.length];
  return s;
}

const DUCKS = ['bori', 'tori', 'nuri', 'mari', 'ari', 'yuri', 'sori', 'nari', 'duri'];

export class QrMatchManager {
  /**
   * @param {import('socket.io').Server} io
   * @param {import('./matchmaker.js').Matchmaker} matchmaker
   */
  constructor(io, matchmaker) {
    this.io = io;
    this.matchmaker = matchmaker;
    /** @type {Map<string, { hostSocket: import('socket.io').Socket, hostProfile: object, terrain: string, timeoutId: ReturnType<typeof setTimeout> }>} */
    this.pending = new Map();
  }

  qrClientBaseUrl() {
    const raw = process.env.QR_CLIENT_BASE_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    return String(raw).split(',')[0].trim().replace(/\/$/, '');
  }

  /** @param {string} uid */
  findHostSocket(uid) {
    for (const [, sock] of this.io.sockets.sockets) {
      if (sock.data?.uid === uid && !sock.data?.qrGuest) return sock;
    }
    return null;
  }

  /**
   * @param {import('jsonwebtoken').JwtPayload & { uid: string, displayName?: string, photoURL?: string }} authPayload
   * @param {object} body
   */
  createPending(authPayload, body) {
    const uid = authPayload.uid;
    const hostSocket = this.findHostSocket(uid);
    if (!hostSocket) return { ok: false, status: 409, error: 'socket_offline' };

    this.cancelForSocket(hostSocket.id);

    let matchCode = randomMatchCode(8);
    let guard = 0;
    while (this.pending.has(matchCode) && guard < 20) {
      matchCode = randomMatchCode(8);
      guard += 1;
    }

    const terrain = normalizeTerrainKey(body?.terrain || 'normal');
    const hostProfile = {
      userId: uid,
      nickname: body?.nickname || authPayload.displayName || '플레이어',
      photoURL: body?.photoURL || authPayload.photoURL || '',
      duckId: body?.duckId || 'bori',
      wins: body?.wins,
      losses: body?.losses,
      draws: body?.draws,
    };
    hostSocket.data.matchProfile = { ...hostProfile };

    const guestToken = signQrGuestToken(matchCode);
    const timeoutId = setTimeout(() => this.expire(matchCode), QR_PENDING_MS);
    this.pending.set(matchCode, { hostSocket, hostProfile, terrain, timeoutId });

    const base = this.qrClientBaseUrl();
    const qrUrl = `${base}/?qr=${encodeURIComponent(matchCode)}&t=${encodeURIComponent(guestToken)}`;

    return {
      ok: true,
      matchCode,
      qrUrl,
      guestToken,
    };
  }

  /** @param {string} matchCode */
  expire(matchCode) {
    const p = this.pending.get(matchCode);
    if (!p) return;
    this.pending.delete(matchCode);
    try {
      p.hostSocket.emit('qrMatchExpired', { matchCode });
    } catch {
      /* ignore */
    }
  }

  /** @param {string} socketId */
  cancelForSocket(socketId) {
    for (const [code, p] of this.pending) {
      if (p.hostSocket?.id === socketId) {
        clearTimeout(p.timeoutId);
        this.pending.delete(code);
        return true;
      }
    }
    return false;
  }

  /** @param {import('socket.io').Socket} socket */
  tryJoinGuest(socket) {
    if (!socket.data?.qrGuest || !socket.data?.qrMatchCode) {
      socket.emit('qrJoinFailed', { reason: 'not_guest' });
      return;
    }
    const matchCode = String(socket.data.qrMatchCode);
    const p = this.pending.get(matchCode);
    if (!p) {
      socket.emit('qrJoinFailed', { reason: 'expired_or_invalid' });
      return;
    }

    const hostBal = getBalance(p.hostSocket.data.uid);
    if (hostBal.balance < 1) {
      socket.emit('qrJoinFailed', { reason: 'host_no_hearts' });
      try {
        p.hostSocket.emit('matchError', { reason: 'noHearts', balance: hostBal.balance });
      } catch {
        /* ignore */
      }
      return;
    }

    clearTimeout(p.timeoutId);
    this.pending.delete(matchCode);

    const duckId = DUCKS[Math.floor(Math.random() * DUCKS.length)] || 'bori';
    const guestProfile = {
      userId: socket.data.uid,
      nickname: socket.data.displayName || '게스트',
      photoURL: socket.data.photoURL || '',
      duckId,
      wins: 0,
      losses: 0,
      draws: 0,
    };
    socket.data.matchProfile = { ...guestProfile };

    const hostEntry = {
      socket: p.hostSocket,
      uid: p.hostSocket.data.uid,
      profile: p.hostProfile,
      slot: 0,
      isBot: false,
    };
    const guestEntry = {
      socket,
      uid: socket.data.uid,
      profile: guestProfile,
      slot: 1,
      isBot: false,
    };
    this.matchmaker.pairQrRoom(p.terrain, hostEntry, guestEntry);
  }

  /** @param {import('socket.io').Socket} socket */
  onDisconnect(socket) {
    this.cancelForSocket(socket.id);
  }
}
