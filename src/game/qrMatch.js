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

  /**
   * QR에 인쇄되는 짧은 링크의 오리진 (이 서버의 `GET /j/:matchCode`가 붙는 공개 URL).
   * 비우면 로컬 개발용으로 `http://localhost:{PORT}` 를 씁니다. 운영에서는 HTTPS 공개 도메인을 권장합니다.
   */
  qrShortJoinBaseUrl() {
    const raw = process.env.QR_SHORT_JOIN_BASE || '';
    const u = String(raw).split(',')[0].trim().replace(/\/$/, '');
    if (u) return u;
    const p = Number(process.env.PORT) || 3100;
    return `http://localhost:${p}`;
  }

  /** @param {string} matchCode */
  isPendingMatch(matchCode) {
    return this.pending.has(String(matchCode));
  }

  /**
   * 같은 uid 다중 탭·기기 시 Map 순회만 하면 "첫 번째" 소켓에 matchFound 가 가고 QR 탭은 영원히 대기함.
   * 클라이언트가 보낸 socketId 를 우선하고, 없으면 connectedAt 이 가장 최근인 소켓을 고른다.
   * @param {string} uid
   * @param {string} [preferredSocketId]
   */
  findHostSocket(uid, preferredSocketId) {
    if (preferredSocketId) {
      const s = this.io.sockets.sockets.get(preferredSocketId);
      if (s?.data?.uid === uid && !s.data?.qrGuest) return s;
    }
    /** @type {import('socket.io').Socket | null} */
    let best = null;
    let bestAt = -1;
    for (const [, sock] of this.io.sockets.sockets) {
      if (sock.data?.uid !== uid || sock.data?.qrGuest) continue;
      const at =
        typeof sock.data.connectedAt === 'number' && Number.isFinite(sock.data.connectedAt)
          ? sock.data.connectedAt
          : 0;
      if (at >= bestAt) {
        bestAt = at;
        best = sock;
      }
    }
    return best;
  }

  /**
   * @param {import('jsonwebtoken').JwtPayload & { uid: string, displayName?: string, photoURL?: string }} authPayload
   * @param {object} body
   */
  createPending(authPayload, body) {
    const uid = authPayload.uid;
    const sid =
      body && typeof body.socketId === 'string' && body.socketId.trim()
        ? body.socketId.trim()
        : undefined;
    const hostSocket = this.findHostSocket(uid, sid);
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

    const shortBase = this.qrShortJoinBaseUrl();
    const qrUrl = `${shortBase}/j/${matchCode}`;

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
