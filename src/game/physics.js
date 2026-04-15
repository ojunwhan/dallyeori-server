/**
 * 클라이언트 constants.js RACE_ENGINE_PHYSICS / 트랙 길이 미러링
 */

export const TRACK_DISTANCE_M = 70;
export const RACE_TIME_LIMIT_SEC = 15;
/** 클라 constants.TAP_STRIDE_M(60cm) 과 동일 — 탭 1회 = 전진 1보, 속도 적분 없음 */
export const TAP_STRIDE_M = 0.6;

export const RACE_ENGINE_PHYSICS = Object.freeze({
  DUCK_MASS: 3.5,
  TAP_FORCE: 1.8,
  MAX_SPEED: 4.5,
  AIR_RESISTANCE: 0.02,
  SAME_FOOT_ANGLE: 0.18,
  ANGLE_RECOVERY: 0.16,
  STUMBLE_THRESHOLD: 2.2,
  STUMBLE_GAP: 0.42,
  STUMBLE_DECEL_PER_S: 5.5,
  TERRAIN: Object.freeze({
    normal: Object.freeze({
      name: '일반 트랙',
      friction: 0.85,
      slideDecay: 0.95,
      trackWidth: Number.POSITIVE_INFINITY,
      slipOnSameFoot: false,
    }),
    ice: Object.freeze({
      name: '얼음판',
      friction: 0.25,
      slideDecay: 0.995,
      trackWidth: Number.POSITIVE_INFINITY,
      slipOnSameFoot: true,
      spinRate: 0.35,
      spinRecovery: 0.05,
    }),
    cliff: Object.freeze({
      name: '벼랑',
      friction: 0.85,
      slideDecay: 0.95,
      trackWidth: 2.0,
      slipOnSameFoot: false,
      fallThreshold: 1.0,
    }),
    iceCliff: Object.freeze({
      name: '얼음 벼랑',
      friction: 0.25,
      slideDecay: 0.995,
      trackWidth: 2.0,
      slipOnSameFoot: true,
      spinRate: 0.35,
      spinRecovery: 0.05,
      fallThreshold: 1.0,
    }),
  }),
});

const DIR_A_LIMIT = 1.57;
const PH = RACE_ENGINE_PHYSICS;

function moveTowardVal(current, target, maxStep) {
  if (current === target) return target;
  const d = target - current;
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

export function normalizeTerrainKey(k) {
  const s = k && String(k);
  if (s === 'ice' || s === 'cliff' || s === 'iceCliff') return s;
  return 'normal';
}

export function getTerrain(key) {
  const k = normalizeTerrainKey(key);
  return RACE_ENGINE_PHYSICS.TERRAIN[k] || RACE_ENGINE_PHYSICS.TERRAIN.normal;
}

export function createDuck() {
  return {
    dist: 0,
    v: 0,
    spd: 0,
    taps: 0,
    lastFoot: /** @type {'L'|'R'|null} */ (null),
    lateral: 0,
    spinAngle: 0,
    stumble: 0,
    lastTapRaceT: 0,
    dirA: 0,
    fallenUntil: 0,
  };
}

/**
 * @param {ReturnType<typeof createDuck>} duck
 * @param {'L'|'R'} foot
 * @param {object} terrain
 * @param {number} raceT
 * @param {{ stumbleScale?: number, sameFootImpulseScale?: number }} [opt]
 */
export function applyTap(duck, foot, terrain, raceT, opt = {}) {
  const stumbleScale = opt.stumbleScale ?? 1;
  const sameFoot = duck.lastFoot === foot;
  let stride = TAP_STRIDE_M * stumbleScale;
  if (duck.stumble) stride *= 0.45;
  if (sameFoot) {
    if (foot === 'L') duck.dirA -= PH.SAME_FOOT_ANGLE;
    else duck.dirA += PH.SAME_FOOT_ANGLE;
    if (terrain.slipOnSameFoot) {
      duck.spinAngle += terrain.spinRate || 0.35;
    }
    stride *= opt.sameFootImpulseScale ?? 0.38;
  } else {
    const r = PH.ANGLE_RECOVERY;
    if (duck.dirA > r) duck.dirA -= r;
    else if (duck.dirA < -r) duck.dirA += r;
    else duck.dirA = 0;
    if (terrain.spinRecovery != null) {
      duck.spinAngle = moveTowardVal(duck.spinAngle, 0, terrain.spinRecovery);
    }
  }
  duck.dirA = Math.max(-DIR_A_LIMIT, Math.min(DIR_A_LIMIT, duck.dirA));
  duck.spinAngle = Math.max(-DIR_A_LIMIT, Math.min(DIR_A_LIMIT, duck.spinAngle));
  const ca = Math.cos(duck.dirA);
  const sa = Math.sin(duck.dirA);
  duck.dist += stride * ca;
  duck.lateral += stride * sa;
  /** 가속 적분 없음 — 표시·스텀블 판정용으로만 짧은 스칼라 유지 */
  duck.v = Math.min(PH.MAX_SPEED, stride * 8);
  duck.spd = duck.v;
  duck.lastFoot = foot;
  duck.taps += 1;
  duck.lastTapRaceT = raceT;
  duck.stumble = 0;
}

/**
 * @param {ReturnType<typeof createDuck>} duck
 * @param {number} dt
 * @param {object} terrain
 * @param {number} raceT
 * @param {boolean} isCpu
 */
export function stepDuck(duck, dt, terrain, raceT, isCpu) {
  if (raceT < duck.fallenUntil) {
    duck.spd = duck.v;
    return;
  }
  const spinRec = terrain.spinRecovery != null ? terrain.spinRecovery : 0.06;
  duck.spinAngle = moveTowardVal(duck.spinAngle, 0, spinRec * dt * 8);
  const prevV = duck.v;
  const dt60 = 60 * dt;
  duck.v *= Math.pow(terrain.slideDecay, dt60);
  const drag = PH.AIR_RESISTANCE * Math.abs(duck.v) * duck.v * dt;
  if (duck.v > 0) duck.v = Math.max(0, duck.v - drag);
  if (isCpu && terrain.fallThreshold != null && Number.isFinite(terrain.fallThreshold)) {
    const cap = terrain.fallThreshold * 0.92;
    duck.lateral = Math.max(-cap, Math.min(cap, duck.lateral));
  }
  if (duck.stumble) {
    duck.v = Math.max(0, duck.v - PH.STUMBLE_DECEL_PER_S * dt);
    if (duck.v < 0.18) duck.stumble = 0;
  } else if (!isCpu) {
    const gap = raceT - duck.lastTapRaceT;
    if (prevV > PH.STUMBLE_THRESHOLD && gap > PH.STUMBLE_GAP) duck.stumble = 1;
  }
  duck.v = Math.max(0, Math.min(PH.MAX_SPEED, duck.v));
  /** 전진·횡이동은 applyTap(한 걸음)에서만 반영 — 탭 속도 = 걸음 속도 */
  duck.spd = duck.v;
  if (!isCpu && terrain.fallThreshold != null && Number.isFinite(terrain.fallThreshold)) {
    if (Math.abs(duck.lateral) > terrain.fallThreshold) {
      duck.fallenUntil = raceT + 2.2;
      duck.lateral = 0;
      duck.v = 0;
      duck.spd = 0;
    }
  }
}

/**
 * @param {ReturnType<typeof createDuck>} duck
 * @param {number} raceT
 */
export function duckToWire(duck, raceT) {
  return {
    dist: duck.dist,
    v: duck.v,
    spd: duck.spd,
    lateral: duck.lateral,
    lateralVelocity: 0,
    dirA: duck.dirA,
    spinAngle: duck.spinAngle,
    /** 클라 상대 다리·3D 스텝 — peerTap 유실 시에도 동기화 */
    lastFoot: duck.lastFoot,
    isSpinning: Math.abs(duck.spinAngle) > 0.08,
    isFallen: raceT < duck.fallenUntil,
    isStumbling: Boolean(duck.stumble),
    taps: duck.taps,
  };
}
