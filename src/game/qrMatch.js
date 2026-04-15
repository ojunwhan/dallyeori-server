import { randomBytes } from 'crypto';
import { signQrGuestToken } from '../auth/session.js';
import { normalizeTerrainKey } from './physics.js';
import { getBalance } from '../db/heartStore.js';

const QR_PENDING_MS = 180_000;
/** 호스트 앱 전환 등 일시 disconnect 시 pending 유지 (카톡 공유 후 재입장 대비) */
const HOST_RECONNECT_GRACE_MS = 30_000;
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
    /**
     * @type {Map<string, {
     *   hostSocket: import('socket.io').Socket,
     *   hostProfile: object,
     *   terrain: string,
     *   timeoutId: ReturnType<typeof setTimeout>,
     *   disconnectedAt?: number,
     *   graceTimerId?: ReturnType<typeof setTimeout>,
     *   guestWaitingSocket?: import('socket.io').Socket,
     * }>}
     */
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

    this.cancelForSocket(hostSocket.id, true);

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
    this._removePending(matchCode, p, 'timed_out');
  }

  /**
   * @param {string} matchCode
   * @param {object} p
   * @param {'timed_out' | 'grace_expired' | 'cancel_immediate' | 'paired'} kind
   */
  _removePending(matchCode, p, kind) {
    try {
      clearTimeout(p.timeoutId);
    } catch {
      /* ignore */
    }
    try {
      if (p.graceTimerId) clearTimeout(p.graceTimerId);
    } catch {
      /* ignore */
    }
    this.pending.delete(matchCode);

    if (kind === 'timed_out' || kind === 'cancel_immediate') {
      try {
        p.hostSocket.emit('qrMatchExpired', { matchCode });
      } catch {
        /* ignore */
      }
    }

    if (p.guestWaitingSocket && kind !== 'paired') {
      try {
        p.guestWaitingSocket.emit('qrJoinFailed', {
          reason: kind === 'grace_expired' ? 'host_reconnect_timeout' : 'expired_or_invalid',
        });
      } catch {
        /* ignore */
      }
    }
  }

  /** @param {string} matchCode */
  _onHostGraceExpired(matchCode) {
    const p = this.pending.get(matchCode);
    if (!p || !p.disconnectedAt) return;
    p.graceTimerId = undefined;
    this._removePending(matchCode, p, 'grace_expired');
  }

  /**
   * 호스트 소켓이 끊긴 pending 에 대해 유예 시작(기본) 또는 즉시 삭제(명시 취소·새 QR 발급).
   * @param {string} socketId
   * @param {boolean} [immediate]
   */
  cancelForSocket(socketId, immediate = false) {
    for (const [code, p] of this.pending) {
      if (p.hostSocket?.id !== socketId) continue;
      if (immediate) {
        this._removePending(code, p, 'cancel_immediate');
        return true;
      }
      if (p.disconnectedAt) return true;
      p.disconnectedAt = Date.now();
      if (p.graceTimerId) clearTimeout(p.graceTimerId);
      p.graceTimerId = setTimeout(
        () => this._onHostGraceExpired(code),
        HOST_RECONNECT_GRACE_MS,
      );
      return true;
    }
    return false;
  }

  /**
   * 같은 uid 로 소켓이 다시 붙었을 때 유예 중인 QR 호스트 소켓을 교체.
   * @param {string} uid
   * @param {import('socket.io').Socket} newSocket
   * @returns {{ ok: true, matchCode: string, qrUrl: string } | null}
   */
  rebindHostSocket(uid, newSocket) {
    if (!newSocket?.data?.uid || newSocket.data.qrGuest) return null;
    const uidStr = String(uid);
    if (String(newSocket.data.uid) !== uidStr) return null;

    for (const [matchCode, p] of this.pending) {
      if (p.hostSocket?.data?.uid !== uidStr) continue;
      if (!p.disconnectedAt) continue;

      const oldSid = p.hostSocket?.id;
      p.hostSocket = newSocket;
      newSocket.data.matchProfile = { ...p.hostProfile };
      delete p.disconnectedAt;
      if (p.graceTimerId) {
        clearTimeout(p.graceTimerId);
        p.graceTimerId = undefined;
      }
      console.log(`[qrMatch] host rebind ${matchCode} ${oldSid}→${newSocket.id}`);

      const guestSock = p.guestWaitingSocket;
      if (guestSock) {
        p.guestWaitingSocket = undefined;
        this._pairGuestWithHost(matchCode, p, guestSock);
      }

      const shortBase = this.qrShortJoinBaseUrl();
      return { ok: true, matchCode, qrUrl: `${shortBase}/j/${matchCode}` };
    }
    return null;
  }

  /**
   * @param {string} matchCode
   * @param {object} p
   * @param {import('socket.io').Socket} guestSocket
   */
  _pairGuestWithHost(matchCode, p, guestSocket) {
    const hostBal = getBalance(p.hostSocket.data.uid);
    if (hostBal.balance < 1) {
      guestSocket.emit('qrJoinFailed', { reason: 'host_no_hearts' });
      try {
        p.hostSocket.emit('matchError', { reason: 'noHearts', balance: hostBal.balance });
      } catch {
        /* ignore */
      }
      this._removePending(matchCode, p, 'cancel_immediate');
      return;
    }

    try {
      clearTimeout(p.timeoutId);
    } catch {
      /* ignore */
    }
    try {
      if (p.graceTimerId) clearTimeout(p.graceTimerId);
    } catch {
      /* ignore */
    }
    this.pending.delete(matchCode);

    const duckId = DUCKS[Math.floor(Math.random() * DUCKS.length)] || 'bori';
    const guestProfile = {
      userId: guestSocket.data.uid,
      nickname: guestSocket.data.displayName || '게스트',
      photoURL: guestSocket.data.photoURL || '',
      duckId,
      wins: 0,
      losses: 0,
      draws: 0,
    };
    guestSocket.data.matchProfile = { ...guestProfile };

    const hostEntry = {
      socket: p.hostSocket,
      uid: p.hostSocket.data.uid,
      profile: p.hostProfile,
      slot: 0,
      isBot: false,
    };
    const guestEntry = {
      socket: guestSocket,
      uid: guestSocket.data.uid,
      profile: guestProfile,
      slot: 1,
      isBot: false,
    };
    this.matchmaker.pairQrRoom(p.terrain, hostEntry, guestEntry);
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

    if (p.disconnectedAt) {
      if (p.guestWaitingSocket && p.guestWaitingSocket.id !== socket.id) {
        socket.emit('qrJoinFailed', { reason: 'room_busy' });
        return;
      }
      p.guestWaitingSocket = socket;
      socket.emit('qrHostReconnecting', { matchCode });
      return;
    }

    this._pairGuestWithHost(matchCode, p, socket);
  }

  /** 대기 중 게스트 소켓이 먼저 끊긴 경우 */
  _clearGuestWaitingIfSocket(socketId) {
    for (const [, p] of this.pending) {
      if (p.guestWaitingSocket?.id === socketId) {
        p.guestWaitingSocket = undefined;
        return true;
      }
    }
    return false;
  }

  /** @param {import('socket.io').Socket} socket */
  onDisconnect(socket) {
    this._clearGuestWaitingIfSocket(socket.id);
    this.cancelForSocket(socket.id);
  }
}
