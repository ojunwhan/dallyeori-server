/**
 * 매칭 타임아웃 시 봇 — 탭 패턴 (지형별 가중치)
 */

/** @param {string} terrainKey */
export function createBotTapScheduler(terrainKey, onTap) {
  let acc = 0;
  let nextGap = 0.14 + Math.random() * 0.08;
  let lastFoot = /** @type {'L'|'R'} */ (Math.random() < 0.5 ? 'L' : 'R');

  function baseGap() {
    if (terrainKey === 'ice' || terrainKey === 'iceCliff') return 0.22 + Math.random() * 0.12;
    if (terrainKey === 'cliff') return 0.12 + Math.random() * 0.05;
    return 0.11 + Math.random() * 0.06;
  }

  return {
    /**
     * @param {number} dt
     * @param {number} raceT
     */
    tick(dt, raceT) {
      acc += dt;
      if (acc < nextGap) return;
      acc = 0;
      nextGap = baseGap();
      const slip = Math.random() < (terrainKey === 'ice' || terrainKey === 'iceCliff' ? 0.14 : 0.07);
      if (slip) {
        onTap(lastFoot, raceT);
      } else {
        lastFoot = lastFoot === 'L' ? 'R' : 'L';
        onTap(lastFoot, raceT);
      }
    },
  };
}

export function randomBotProfile() {
  const nicks = ['러너K', '한강오리', '탭고수', '스피드덕', '캐주얼러너'];
  const ducks = ['bori', 'tori', 'nuri', 'mari', 'ari'];
  return {
    userId: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    nickname: nicks[Math.floor(Math.random() * nicks.length)],
    profilePhotoURL: '',
    duckId: ducks[Math.floor(Math.random() * ducks.length)],
    wins: Math.floor(Math.random() * 40),
    losses: Math.floor(Math.random() * 40),
    draws: Math.floor(Math.random() * 10),
  };
}
