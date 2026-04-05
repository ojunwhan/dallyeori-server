import {
  RACE_TIME_LIMIT_SEC,
  TRACK_DISTANCE_M,
  applyTap,
  createDuck,
  duckToWire,
  getTerrain,
  normalizeTerrainKey,
  stepDuck,
} from './physics.js';
import { createBotTapScheduler } from './botPlayer.js';
import { addHearts, consumeHearts, getBalance } from '../db/heartStore.js';

const TICK_MS = 16;

function duckMeta(duckId) {
  const m = {
    bori: { duckName: '보리', duckColor: '#007AFF' },
    tori: { duckName: '토리', duckColor: '#FF3B30' },
    nuri: { duckName: '누리', duckColor: '#34C759' },
    mari: { duckName: '마리', duckColor: '#FFD700' },
    ari: { duckName: '아리', duckColor: '#F2F2F7' },
    yuri: { duckName: '유리', duckColor: '#283593' },
    sori: { duckName: '소리', duckColor: '#FF9500' },
    nari: { duckName: '나리', duckColor: '#AF52DE' },
    duri: { duckName: '두리', duckColor: '#1C1C1E' },
  };
  return m[duckId] || m.bori;
}

export class RaceRoom {
  /**
   * @param {import('socket.io').Server} io
   * @param {string} roomId
   * @param {{ socket: import('socket.io').Socket | null, uid: string, profile: object, slot: number, isBot?: boolean }} a
   * @param {{ socket: import('socket.io').Socket | null, uid: string, profile: object, slot: number, isBot?: boolean }} b
   * @param {string} terrainKey
   * @param {{ isQrMatch?: boolean, onAbortedBeforeRace?: () => void }} [opts]
   */
  constructor(io, roomId, a, b, terrainKey, opts = {}) {
    this.io = io;
    this.roomId = roomId;
    /** QR: 호스트만 race_entry 차감 */
    this.isQrMatch = Boolean(opts.isQrMatch);
    this.onAbortedBeforeRace =
      typeof opts.onAbortedBeforeRace === 'function' ? opts.onAbortedBeforeRace : null;
    this.channel = `race:${roomId}`;
    this.terrainKey = normalizeTerrainKey(terrainKey);
    this.terrain = getTerrain(this.terrainKey);
    this.ducks = [createDuck(), createDuck()];
    this.entries = [a, b];
    this.joined = new Set();
    if (a.isBot) this.joined.add(0);
    if (b.isBot) this.joined.add(1);
    this.raceT = 0;
    /** @type {'wait_join'|'pending_start'|'racing'|'done'} */
    this.phase = 'wait_join';
    /** @type {ReturnType<typeof setInterval> | null} */
    this.tickTimer = null;
    /** @type {ReturnType<typeof createBotTapScheduler> | null} */
    this.botScheduler = b.isBot ? createBotTapScheduler(this.terrainKey, (foot, t) => {
      applyTap(this.ducks[1], foot, this.terrain, t, { cpuMul: 0.92, sameFootImpulseScale: 0.38 });
    }) : a.isBot
      ? createBotTapScheduler(this.terrainKey, (foot, t) => {
          applyTap(this.ducks[0], foot, this.terrain, t, { cpuMul: 0.92, sameFootImpulseScale: 0.38 });
        })
      : null;
    this.botSlot = a.isBot ? 0 : b.isBot ? 1 : -1;
    /** @type {number | null} */
    this.pendingStartAt = null;
    /** 레이스 실제 시작 시각 (ms) — raceTick.raceT = (now - raceStartAt)/1000 */
    /** @type {number | null} */
    this.raceStartAt = null;
    /** 서버 카운트다운 시작 시각 (syncClient용) */
    /** @type {number | null} */
    this.countdownStartedAt = null;
    /** @type {ReturnType<typeof setTimeout>[]} */
    this._countdownTimers = [];
    /** 5초 단위 raceTick 디버그 로그용 */
    /** @type {number | undefined} */
    this._dbgRaceTickLogBucket = undefined;
  }

  _clearCountdownTimers() {
    for (const t of this._countdownTimers) {
      clearTimeout(t);
    }
    this._countdownTimers = [];
  }

  /**
   * 3 → 2 → 1 → 0(GO!) 초마다 emit, 이후 250ms 뒤 레이스 시작
   */
  _startServerCountdown() {
    this._clearCountdownTimers();
    this.countdownStartedAt = Date.now();
    const counts = [3, 2, 1, 0];
    counts.forEach((count, i) => {
      const tid = setTimeout(() => {
        if (this.phase !== 'pending_start') return;
        this.io.to(this.channel).emit('countdown', { count });
        if (count === 0) {
          const tidGo = setTimeout(() => {
            if (this.phase === 'pending_start') this.beginRacing();
          }, 250);
          this._countdownTimers.push(tidGo);
        }
      }, i * 1000);
      this._countdownTimers.push(tid);
    });
  }

  /**
   * 늦게 race 화면에 진입한 소켓에 카운트다운/진행 상태 동기화
   * @param {import('socket.io').Socket} socket
   */
  syncClient(socket) {
    if (this.phase === 'pending_start' && this.countdownStartedAt != null) {
      const elapsed = Date.now() - this.countdownStartedAt;
      const idx = Math.min(3, Math.floor(elapsed / 1000));
      const counts = [3, 2, 1, 0];
      socket.emit('countdown', { count: counts[idx], sync: true });
      return;
    }
    if (this.phase === 'racing') {
      socket.emit('race-start');
      socket.emit('raceGo');
      const wallT =
        this.raceStartAt != null ? (Date.now() - this.raceStartAt) / 1000 : this.raceT;
      const players = [
        duckToWire(this.ducks[0], this.raceT),
        duckToWire(this.ducks[1], this.raceT),
      ];
      socket.emit('raceTick', { raceT: wallT, players });
    }
  }

  /**
   * @param {import('socket.io').Socket} socket
   */
  attachSocket(socket) {
    const prev = socket.data?.raceChannel;
    if (prev && typeof prev === 'string' && prev !== this.channel) {
      try {
        socket.leave(prev);
      } catch {
        /* ignore */
      }
    }
    socket.join(this.channel);
    socket.data.raceChannel = this.channel;
  }

  /**
   * @param {number} slot
   */
  playerJoined(slot) {
    this.joined.add(slot);
    if (this.joined.size >= 2 && this.phase === 'wait_join') {
      this.phase = 'pending_start';
      this.pendingStartAt = Date.now();
      this.io.to(this.channel).emit('race-matched', { roomId: this.roomId });
      this._startServerCountdown();
    }
  }

  beginRacing() {
    if (this.phase === 'done') return;
    /** @type {string[]} */
    const chargedUids = [];
    for (let slot = 0; slot < 2; slot += 1) {
      const e = this.entries[slot];
      if (!e || e.isBot) continue;
      if (this.isQrMatch && slot === 1) continue;
      const r = consumeHearts(e.uid, 1, 'race_entry');
      if (!r.success) {
        for (const uid of chargedUids) {
          addHearts(uid, 1, 'race_entry_refund');
        }
        this._clearCountdownTimers();
        this.phase = 'done';
        this.io.to(this.channel).emit('raceAborted', {
          reason: 'noHearts',
          failedUid: e.uid,
          balance: r.balance,
        });
        try {
          this.onAbortedBeforeRace?.();
        } catch {
          /* ignore */
        }
        return;
      }
      chargedUids.push(e.uid);
    }
    this._clearCountdownTimers();
    this.phase = 'racing';
    this.raceStartAt = Date.now();
    this.raceT = 0;
    this.io.to(this.channel).emit('race-start');
    this.io.to(this.channel).emit('raceGo');
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  tick() {
    if (this.phase !== 'racing') return;
    const dt = TICK_MS / 1000;
    const wallT =
      this.raceStartAt != null ? (Date.now() - this.raceStartAt) / 1000 : this.raceT + dt;
    this.raceT = wallT;
    if (this.botScheduler != null && this.botSlot >= 0) {
      this.botScheduler.tick(dt, this.raceT);
    }
    stepDuck(this.ducks[0], dt, this.terrain, this.raceT, this.botSlot === 0);
    stepDuck(this.ducks[1], dt, this.terrain, this.raceT, this.botSlot === 1);
    if (this.ducks[0].dist >= TRACK_DISTANCE_M || this.ducks[1].dist >= TRACK_DISTANCE_M) {
      if (this.ducks[0].dist >= TRACK_DISTANCE_M && this.ducks[1].dist >= TRACK_DISTANCE_M) {
        this.finish(this.ducks[0].dist >= this.ducks[1].dist ? 0 : 1);
      } else if (this.ducks[0].dist >= TRACK_DISTANCE_M) {
        this.finish(0);
      } else {
        this.finish(1);
      }
      return;
    }
    if (wallT >= RACE_TIME_LIMIT_SEC) {
      const eps = 1e-5;
      let w = 1;
      if (this.ducks[0].dist > this.ducks[1].dist + eps) w = 0;
      else if (this.ducks[0].dist < this.ducks[1].dist - eps) w = 1;
      else w = -1;
      this.finish(w);
      return;
    }
    this.broadcastTick();
  }

  /**
   * @param {number} winnerSlot -1 무승부
   */
  finish(winnerSlot) {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this._clearCountdownTimers();
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    const wallT =
      this.raceStartAt != null ? (Date.now() - this.raceStartAt) / 1000 : this.raceT;

    const e0 = this.entries[0];
    const e1 = this.entries[1];
    const uid0 = e0 && !e0.isBot ? e0.uid : null;
    const uid1 = e1 && !e1.isBot ? e1.uid : null;

    if (winnerSlot === -1) {
      if (this.isQrMatch) {
        if (uid0) addHearts(uid0, 1, 'race_draw_refund', uid1 || undefined);
      } else {
        if (uid0) addHearts(uid0, 1, 'race_draw_refund', uid1 || undefined);
        if (uid1) addHearts(uid1, 1, 'race_draw_refund', uid0 || undefined);
      }
    } else {
      const w = winnerSlot;
      const winnerEntry = w === 0 ? e0 : e1;
      const loserEntry = w === 0 ? e1 : e0;
      const winnerUid = winnerEntry && !winnerEntry.isBot ? winnerEntry.uid : null;
      const loserUid = loserEntry && !loserEntry.isBot ? loserEntry.uid : null;
      if (winnerUid) {
        addHearts(winnerUid, 1, 'race_win', loserUid || undefined);
      }
    }

    /** @type {Record<string, number>} */
    const hearts = {};
    if (uid0) hearts[uid0] = getBalance(uid0).balance;
    if (uid1) hearts[uid1] = getBalance(uid1).balance;

    const payload = {
      winnerSlot,
      raceTime: Math.min(wallT, RACE_TIME_LIMIT_SEC),
      distances: [this.ducks[0].dist, this.ducks[1].dist],
      taps: [this.ducks[0].taps, this.ducks[1].taps],
      hearts,
    };
    this.io.to(this.channel).emit('raceResult', payload);
  }

  broadcastTick() {
    const wallT =
      this.raceStartAt != null ? (Date.now() - this.raceStartAt) / 1000 : this.raceT;
    const players = [
      duckToWire(this.ducks[0], this.raceT),
      duckToWire(this.ducks[1], this.raceT),
    ];
    const tickBucket = Math.floor(wallT / 5);
    if (tickBucket !== this._dbgRaceTickLogBucket) {
      this._dbgRaceTickLogBucket = tickBucket;
      console.log(
        '[server] raceTick broadcast, p1(dist):',
        this.ducks[0].dist,
        'p2:',
        this.ducks[1].dist,
        'raceT(wall):',
        wallT,
      );
    }
    this.io.to(this.channel).emit('raceTick', {
      raceT: wallT,
      players,
    });
  }

  /**
   * @param {number} slot
   * @param {'left'|'right'} foot
   */
  onTap(slot, foot) {
    if (this.phase !== 'racing') {
      console.log('[server] onTap ignored: phase is', this.phase, { slot, foot });
      return;
    }
    const f = foot === 'right' ? 'R' : 'L';
    applyTap(this.ducks[slot], f, this.terrain, this.raceT, {});
    const opp = 1 - slot;
    const peerEntry = this.entries[opp];
    if (peerEntry?.socket && !peerEntry.isBot) {
      peerEntry.socket.emit('peerTap', { slot, foot });
    } else {
      console.log('[server] peerTap skip', {
        oppSlot: opp,
        foot,
        entry: peerEntry
          ? { hasSocket: !!peerEntry.socket, isBot: !!peerEntry.isBot }
          : null,
        entries: this.entries.map((e, i) => ({
          i,
          hasSocket: !!(e && e.socket),
          isBot: !!(e && e.isBot),
        })),
      });
    }
  }
}

export function profileToOpponent(profile) {
  const duckId = profile.duckId || 'bori';
  const dm = duckMeta(duckId);
  return {
    userId: profile.userId || 'unknown',
    nickname: profile.nickname || '플레이어',
    profilePhotoURL: profile.photoURL || '',
    duckId,
    duckName: dm.duckName,
    duckColor: dm.duckColor,
    wins: profile.wins ?? 0,
    losses: profile.losses ?? 0,
    draws: profile.draws ?? 0,
  };
}
