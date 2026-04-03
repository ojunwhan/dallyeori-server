import { RaceRoom, profileToOpponent } from './raceRoom.js';
import { randomBotProfile } from './botPlayer.js';
import { normalizeTerrainKey } from './physics.js';

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
    const merged = {
      userId: socket.data.uid,
      nickname: profile.nickname || socket.data.displayName || '플레이어',
      photoURL: profile.photoURL || '',
      duckId: profile.duckId || 'bori',
      wins: profile.wins,
      losses: profile.losses,
      draws: profile.draws,
    };
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
    const room = new RaceRoom(this.io, roomId, pa, pb, terrain);
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
    const room = new RaceRoom(this.io, roomId, pa, pb, terrain);
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
    const room = new RaceRoom(this.io, roomId, pa, pb, terrain);
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
}
