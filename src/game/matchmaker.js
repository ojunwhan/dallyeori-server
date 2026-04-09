import { RaceRoom, profileToOpponent } from './raceRoom.js';
import { randomBotProfile } from './botPlayer.js';
import { normalizeTerrainKey } from './physics.js';
import { getBalance } from '../db/heartStore.js';

/**
 * 재매치·매칭용 — socket.data.matchProfile 우선, 없으면 JWT/소켓 표시 정보 폴백
 * @param {import('socket.io').Socket} s
 */
export function getMatchProfile(s) {
  const mp = s.data?.matchProfile;
  if (mp && typeof mp === 'object') {
    return {
      userId: s.data.uid,
      nickname: mp.nickname || s.data.displayName || '플레이어',
      photoURL: mp.photoURL || s.data.photoURL || '',
      duckId: mp.duckId || 'bori',
      wins: mp.wins ?? 0,
      losses: mp.losses ?? 0,
      draws: mp.draws ?? 0,
    };
  }
  return {
    userId: s.data.uid,
    nickname: s.data.displayName || '플레이어',
    photoURL: s.data.photoURL || '',
    duckId: 'bori',
    wins: 0,
    losses: 0,
    draws: 0,
  };
}

const MATCH_TIMEOUT_MS = 30_000;

/**
 * @typedef {{ socket: import('socket.io').Socket, uid: string, profile: object }} QueueEntry
 */

export class Matchmaker {
  /**
   * @param {import('socket.io').Server} io
   */
  constructor(io) {
    this.io = io;
    /** @type {Map<string, QueueEntry[]>} */
    this.queues = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this.timeouts = new Map();
    /** @type {Map<string, RaceRoom>} */
    this.rooms = new Map();
    /** @type {Map<string, string>} socketId -> roomId */
    this.socketRoom = new Map();
  }

  /**
   * 하트 부족 등으로 레이스 시작 전 중단 시 방·소켓 매핑 제거
   * @param {string} roomId
   */
  _dropRoom(roomId) {
    if (!this.rooms.has(roomId)) return;
    this.rooms.delete(roomId);
    for (const [sid, rid] of [...this.socketRoom.entries()]) {
      if (rid === roomId) this.socketRoom.delete(sid);
    }
  }

  /**
   * @param {string} terrain
   * @returns {QueueEntry[]}
   */
  _q(terrain) {
    const k = normalizeTerrainKey(terrain);
    if (!this.queues.has(k)) this.queues.set(k, []);
    return /** @type {QueueEntry[]} */ (this.queues.get(k));
  }

  /**
   * @param {import('socket.io').Socket} socket
   * @param {string} terrain
   * @param {object} profile
   */
  enqueue(socket, terrain, profile) {
    this.cancel(socket.id, false);
    const hb = getBalance(socket.data.uid);
    if (hb.balance < 1) {
      socket.emit('matchError', { reason: 'noHearts', balance: hb.balance });
      return;
    }
    const merged = {
      userId: socket.data.uid,
      nickname: profile.nickname || socket.data.displayName || '플레이어',
      photoURL: profile.photoURL || '',
      duckId: profile.duckId || 'bori',
      wins: profile.wins,
      losses: profile.losses,
      draws: profile.draws,
    };
    socket.data.matchProfile = merged;
    const entry = { socket, uid: socket.data.uid, profile: merged };
    const q = this._q(terrain);
    q.push(entry);
    const tid = setTimeout(() => this._timeoutMatch(socket.id, terrain), MATCH_TIMEOUT_MS);
    this.timeouts.set(socket.id, tid);
    if (q.length >= 2) {
      const a = q.shift();
      const b = q.shift();
      if (a && b) {
        this._clearTimeout(a.socket.id);
        this._clearTimeout(b.socket.id);
        this._createHumanRoom(terrain, a, b);
      }
    }
  }

  /**
   * @param {string} socketId
   * @param {string} terrain
   */
  _timeoutMatch(socketId, terrain) {
    this.timeouts.delete(socketId);
    const q = this._q(terrain);
    const idx = q.findIndex((e) => e.socket.id === socketId);
    if (idx === -1) return;
    const human = q.splice(idx, 1)[0];
    if (!human) return;
    const botProfile = randomBotProfile();
    const botEntry = {
      socket: null,
      uid: botProfile.userId,
      profile: {
        userId: botProfile.userId,
        nickname: botProfile.nickname,
        photoURL: botProfile.profilePhotoURL,
        duckId: botProfile.duckId,
        wins: botProfile.wins,
        losses: botProfile.losses,
        draws: botProfile.draws,
      },
      isBot: true,
    };
    this._createRoomWithBot(terrain, human, botEntry);
  }

  /**
   * @param {string} terrain
   * @param {QueueEntry} a
   * @param {QueueEntry} b
   */
  _createHumanRoom(terrain, a, b) {
    const roomId = `rm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const pa = { ...a, slot: 0, isBot: false };
    const pb = { ...b, slot: 1, isBot: false };
    const room = new RaceRoom(this.io, roomId, pa, pb, terrain, {
      isQrMatch: false,
      onAbortedBeforeRace: () => this._dropRoom(roomId),
    });
    this.rooms.set(roomId, room);
    this.socketRoom.set(a.socket.id, roomId);
    this.socketRoom.set(b.socket.id, roomId);
    room.attachSocket(a.socket);
    room.attachSocket(b.socket);
    a.socket.emit('matchFound', {
      roomId,
      slot: 0,
      terrain: normalizeTerrainKey(terrain),
      myDuckId: pa.profile.duckId || 'bori',
      opponent: profileToOpponent(pb.profile),
    });
    b.socket.emit('matchFound', {
      roomId,
      slot: 1,
      terrain: normalizeTerrainKey(terrain),
      myDuckId: pb.profile.duckId || 'bori',
      opponent: profileToOpponent(pa.profile),
    });
  }

  /**
   * @param {string} terrain
   * @param {QueueEntry} human
   * @param {object} botEntry
   */
  _createRoomWithBot(terrain, human, botEntry) {
    const roomId = `rm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const pa = { ...human, slot: 0, isBot: false };
    const pb = { ...botEntry, slot: 1, isBot: true };
    const room = new RaceRoom(this.io, roomId, pa, pb, terrain, {
      isQrMatch: false,
      onAbortedBeforeRace: () => this._dropRoom(roomId),
    });
    this.rooms.set(roomId, room);
    this.socketRoom.set(human.socket.id, roomId);
    room.attachSocket(human.socket);
    human.socket.emit('matchFound', {
      roomId,
      slot: 0,
      terrain: normalizeTerrainKey(terrain),
      myDuckId: pa.profile.duckId || 'bori',
      opponent: profileToOpponent(pb.profile),
    });
  }

  /**
   * QR 매치: 호스트·게스트 소켓이 이미 연결된 상태에서 방만 생성
   * @param {string} terrain
   * @param {QueueEntry} hostEntry
   * @param {QueueEntry} guestEntry
   */
  pairQrRoom(terrain, hostEntry, guestEntry) {
    const roomId = `rm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const pa = { ...hostEntry, slot: 0, isBot: false };
    const pb = { ...guestEntry, slot: 1, isBot: false };
    const room = new RaceRoom(this.io, roomId, pa, pb, terrain, {
      isQrMatch: true,
      onAbortedBeforeRace: () => this._dropRoom(roomId),
    });
    this.rooms.set(roomId, room);
    this.socketRoom.set(hostEntry.socket.id, roomId);
    this.socketRoom.set(guestEntry.socket.id, roomId);
    room.attachSocket(hostEntry.socket);
    room.attachSocket(guestEntry.socket);
    hostEntry.socket.emit('matchFound', {
      roomId,
      slot: 0,
      terrain: normalizeTerrainKey(terrain),
      myDuckId: pa.profile.duckId || 'bori',
      opponent: profileToOpponent(pb.profile),
    });
    guestEntry.socket.emit('matchFound', {
      roomId,
      slot: 1,
      terrain: normalizeTerrainKey(terrain),
      myDuckId: pb.profile.duckId || 'bori',
      opponent: profileToOpponent(pa.profile),
    });
  }

  /**
   * 종료된 경기 방에 남아 있는 socketRoom 매핑 제거 (재매치 전 정리)
   * @param {string} socketId
   */
  cleanupFinishedRoomForSocket(socketId) {
    const rid = this.socketRoom.get(socketId);
    if (!rid) return;
    const room = this.rooms.get(rid);
    if (!room) {
      this.socketRoom.delete(socketId);
      return;
    }
    if (room.phase !== 'done') return;
    this.rooms.delete(rid);
    for (const [sid, r] of [...this.socketRoom.entries()]) {
      if (r === rid) this.socketRoom.delete(sid);
    }
  }

  /**
   * 재대전 수락 — 큐에서 빼고 새 휴먼 룸 생성
   * @param {string} terrainKey
   * @param {import('socket.io').Socket} socketA
   * @param {import('socket.io').Socket} socketB
   * @returns {boolean}
   */
  pairDirectRematch(terrainKey, socketA, socketB) {
    if (!socketA?.data?.uid || !socketB?.data?.uid) return false;
    if (socketA.data.uid === socketB.data.uid) return false;
    this.cleanupFinishedRoomForSocket(socketA.id);
    this.cleanupFinishedRoomForSocket(socketB.id);
    this.cancel(socketA.id, true);
    this.cancel(socketB.id, true);
    const pa = getMatchProfile(socketA);
    const pb = getMatchProfile(socketB);
    const a = {
      socket: socketA,
      uid: socketA.data.uid,
      profile: pa,
    };
    const b = {
      socket: socketB,
      uid: socketB.data.uid,
      profile: pb,
    };
    const ba = getBalance(socketA.data.uid);
    const bb = getBalance(socketB.data.uid);
    if (ba.balance < 1) {
      socketA.emit('matchError', { reason: 'noHearts', balance: ba.balance });
      return false;
    }
    if (bb.balance < 1) {
      socketB.emit('matchError', { reason: 'noHearts', balance: bb.balance });
      return false;
    }
    this._createHumanRoom(terrainKey, a, b);
    return true;
  }

  /**
   * @param {string} socketId
   * @param {boolean} [leaveQueueOnly]
   */
  cancel(socketId, leaveQueueOnly = true) {
    this._clearTimeout(socketId);
    for (const [, q] of this.queues) {
      const i = q.findIndex((e) => e.socket.id === socketId);
      if (i !== -1) q.splice(i, 1);
    }
    if (!leaveQueueOnly) {
      const rid = this.socketRoom.get(socketId);
      if (rid) {
        this.rooms.delete(rid);
        this.socketRoom.delete(socketId);
      }
    }
  }

  /** @param {string} socketId */
  _clearTimeout(socketId) {
    const t = this.timeouts.get(socketId);
    if (t) clearTimeout(t);
    this.timeouts.delete(socketId);
  }

  /**
   * @param {string} roomId
   * @returns {RaceRoom | undefined}
   */
  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  /**
   * Socket.IO 재연결 시 id 가 바뀌면 socketRoom 에 없어 raceJoin·tap 이 전부 막힘 — uid+slot 으로 엔트리 소켓 갱신
   * @param {string} roomId
   * @param {0|1} slot
   * @param {import('socket.io').Socket} socket
   * @returns {boolean}
   */
  rebindRaceSocket(roomId, slot, socket) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const uid = socket.data?.uid;
    if (!uid || typeof uid !== 'string') return false;
    const mapped = room.slotPlayerUids && room.slotPlayerUids[slot];
    if (mapped != null && mapped !== uid) return false;
    const e = room.entries[slot];
    if (!e || e.isBot || e.uid !== uid) return false;
    const oldSock = e.socket;
    if (oldSock && oldSock.id !== socket.id) {
      this.socketRoom.delete(oldSock.id);
      try {
        oldSock.leave(room.channel);
      } catch {
        /* ignore */
      }
      try {
        if (oldSock.connected) oldSock.disconnect(true);
      } catch {
        /* ignore */
      }
    }
    e.socket = socket;
    this.socketRoom.set(socket.id, roomId);
    room.attachSocket(socket);
    return true;
  }
}
