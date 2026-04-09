/**
 * 매칭 타임아웃 시 봇 — 사람처럼 느껴지는 탭 리듬 (지형·난이도·유저 거리 적응)
 */

import { TRACK_DISTANCE_M } from './physics.js';

const LAST_SPRINT_M = 10;

/** @param {number} x @param {number} a @param {number} b */
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

/** @param {number} t 0~1 */
function smoothstep(t) {
  const u = clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
}

/**
 * @param {string} terrainKey
 * @param {(foot: 'L'|'R', raceT: number) => void} onTap
 * @param {number} [difficulty=0.5] 0=초보 … 1=고수
 */
export function createBotTapScheduler(terrainKey, onTap, difficulty = 0.5) {
  const skill = clamp(Number(difficulty) || 0.5, 0, 1);

  let acc = 0;
  let nextGap = 0.25;
  let lastFoot = /** @type {'L'|'R'} */ (Math.random() < 0.5 ? 'L' : 'R');

  /** 8초 이후 ~ 마지막 10m 전: 가벼운 스퍼트/지침 */
  let post8Mode = /** @type {'sprint'|'tired'|null} */ (null);

  /** 마지막 10m 진입 시 55% 유저 유리(지침) / 45% 봇 유리(스퍼트), 블렌드 */
  let finaleActive = false;
  let finaleUserFavor = false;
  let finaleBlend = 0;
  let finaleDur = 0.75;

  let slipChainLeft = 0;
  let burstLeft = 0;
  let restBeatPending = false;

  function terrainAmp() {
    if (terrainKey === 'ice' || terrainKey === 'iceCliff') return 1.18;
    if (terrainKey === 'cliff') return 0.92;
    return 1;
  }

  function terrainMistakeMul() {
    if (terrainKey === 'ice' || terrainKey === 'iceCliff') return 1.35;
    return 1;
  }

  /** 구간별 베이스 간격(초) — 작을수록 빠른 탭 */
  function phaseBaseGap(raceT) {
    const t = raceT;
    const amp = terrainAmp();
    if (t < 2) {
      return (0.2 + Math.random() * 0.04) * amp * 1.55;
    }
    if (t < 8) {
      const u = (t - 2) / 6;
      const g = 0.2 * amp * lerp(1.35, 0.72, u * u);
      return g;
    }
    if (post8Mode == null) {
      post8Mode = Math.random() < 0.5 ? 'sprint' : 'tired';
    }
    const post = post8Mode === 'sprint' ? 0.88 : 1.1;
    return 0.13 * amp * post;
  }

  function lerp(a, b, u) {
    return a + (b - a) * u;
  }

  function maybeStartBurst() {
    if (burstLeft > 0 || restBeatPending) return;
    if (Math.random() < 0.07) {
      burstLeft = 2 + Math.floor(Math.random() * 2);
    }
  }

  /**
   * 매 tick(dt)마다 호출 — 마지막 10m 승부 블렌드가 시간에 따라 부드럽게 진행되게 함
   * @param {number} dt
   * @param {number|undefined} humanDist
   * @param {number|undefined} botDist
   */
  function stepFinaleAndGetMul(dt, humanDist, botDist) {
    const h = humanDist != null && Number.isFinite(humanDist) ? humanDist : null;
    const b = botDist != null && Number.isFinite(botDist) ? botDist : null;
    let leader = 0;
    let hasAny = false;
    if (h != null) {
      leader = h;
      hasAny = true;
    }
    if (b != null) {
      leader = hasAny ? Math.max(leader, b) : b;
      hasAny = true;
    }
    if (!hasAny) return 1;

    const inFinale = leader >= TRACK_DISTANCE_M - LAST_SPRINT_M;
    if (!inFinale) return 1;

    if (!finaleActive) {
      finaleActive = true;
      finaleUserFavor = Math.random() < 0.55;
      finaleBlend = 0;
      finaleDur = 0.5 + Math.random() * 0.5;
    }

    if (finaleBlend < 1) {
      finaleBlend = clamp(finaleBlend + dt / finaleDur, 0, 1);
    }

    const w = smoothstep(finaleBlend);
    /** 유저 유리 → 봇 지침(간격↑), 봇 유리 → 스퍼트(간격↓) */
    const targetMul = finaleUserFavor ? 1.28 : 0.78;
    return lerp(1, targetMul, w);
  }

  /**
   * @param {number|undefined} humanDist
   * @param {number|undefined} botDist
   */
  function adaptiveMul(humanDist, botDist) {
    if (humanDist == null || botDist == null) return 1;
    if (!Number.isFinite(humanDist) || !Number.isFinite(botDist)) return 1;
    const gapM = botDist - humanDist;
    if (Math.abs(gapM) <= 0.85) return 1;
    if (gapM > 0) {
      return 1 + Math.min(0.38, (gapM - 0.85) * 0.11);
    }
    return 1 - Math.min(0.32, (-gapM - 0.85) * 0.1);
  }

  function difficultyGapScale() {
    return lerp(1.2, 0.76, skill);
  }

  function slipProbability(pace01) {
    const base = lerp(0.05, 0.15, pace01) * lerp(1.12, 0.68, skill) * terrainMistakeMul();
    return clamp(base, 0.02, 0.22);
  }

  return {
    /**
     * @param {number} dt
     * @param {number} raceT
     * @param {number} [humanDist] 유저(킬) 오리 dist — 없으면 거리 적응 생략
     * @param {number} [botDist] 봇 오리 dist — 없으면 거리 적응 생략
     */
    tick(dt, raceT, humanDist, botDist) {
      const finaleMul = stepFinaleAndGetMul(dt, humanDist, botDist);

      acc += dt;
      if (acc < nextGap) return;
      acc = 0;

      let g = phaseBaseGap(raceT);
      g *= difficultyGapScale();
      g *= adaptiveMul(humanDist, botDist);
      g *= finaleMul;

      if (burstLeft > 0) {
        g *= 0.52;
        burstLeft -= 1;
        if (burstLeft === 0) restBeatPending = true;
      } else if (restBeatPending) {
        g *= 1.55 + Math.random() * 0.35;
        restBeatPending = false;
      } else {
        maybeStartBurst();
      }

      g *= 0.8 + Math.random() * 0.4;

      const paceFast01 = clamp((0.26 - Math.min(g, 0.26)) / 0.22, 0, 1);
      const slipProb = slipProbability(paceFast01);

      if (slipChainLeft > 0) {
        onTap(lastFoot, raceT);
        slipChainLeft -= 1;
        nextGap = g;
        return;
      }

      const slipRoll = Math.random() < slipProb;
      if (slipRoll) {
        onTap(lastFoot, raceT);
        if (Math.random() < 0.12) {
          slipChainLeft = 1 + Math.floor(Math.random() * 2);
        }
      } else {
        lastFoot = lastFoot === 'L' ? 'R' : 'L';
        onTap(lastFoot, raceT);
      }

      nextGap = g;
    },
  };
}

const BOT_DUCK_IDS = ['tori', 'sori', 'mari', 'nuri', 'bori', 'yuri', 'nari', 'duri', 'ari'];

const BOT_NICKS = [
  '한강출근덕',
  '탭하는먹보',
  '발빠른누리',
  '꽥꽥이번판',
  '두리번덕',
  '삐약아는척',
  '워킹덕',
  '런덕런',
  '팔딱이',
  '물만난오리',
  '털털이',
  '노랑둥이',
  '비트박스덕',
  '터보아리',
  '달리기장인',
  '오리발바닥',
  '퐁당덕',
  '꽥이보글',
  '런닝머신K',
  '숨참고탭',
  '라스트스퍼트덕',
  '페이스메이커덕',
  '졸린오리',
  '몸풀기중',
  '탭신스',
  '덕덕펀치',
  '웨이브웨이브',
  '삼겹덕',
  '풀코스오리',
  '잠만보깨워',
];

export function randomBotProfile() {
  return {
    userId: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    nickname: BOT_NICKS[Math.floor(Math.random() * BOT_NICKS.length)],
    profilePhotoURL: '',
    duckId: BOT_DUCK_IDS[Math.floor(Math.random() * BOT_DUCK_IDS.length)],
    wins: Math.floor(Math.random() * 40),
    losses: Math.floor(Math.random() * 40),
    draws: Math.floor(Math.random() * 10),
  };
}
