/**
 * 달려오리 전용 유저 등록 상태 (MONO / lingora DB와 무관한 로컬 JSON 저장소)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DALLYEORI_DATA_DIR || join(process.cwd(), 'data');
const USERS_FILE = join(DATA_DIR, 'dallyeori-users.json');

/** @returns {Record<string, { profileSetupComplete: boolean, createdAt: number, completedAt?: number }>} */
function readAll() {
  try {
    if (!existsSync(USERS_FILE)) return {};
    const raw = readFileSync(USERS_FILE, 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, object>} map */
function writeAll(map) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(USERS_FILE, JSON.stringify(map, null, 0), 'utf8');
}

export function getUserStorePath() {
  return USERS_FILE;
}

/**
 * @param {string} uid google: / kakao: 등
 * @returns {{ record: { profileSetupComplete: boolean, createdAt: number }, isFirstSeen: boolean }}
 */
export function ensureAuthUser(uid) {
  if (!uid || typeof uid !== 'string') {
    throw new Error('invalid uid');
  }
  const all = readAll();
  if (all[uid]) {
    const r = all[uid];
    const profileSetupComplete = Boolean(r.profileSetupComplete);
    return {
      record: {
        profileSetupComplete,
        createdAt: Number(r.createdAt) || Date.now(),
        completedAt: r.completedAt,
      },
      isFirstSeen: false,
    };
  }
  const record = { profileSetupComplete: false, createdAt: Date.now() };
  all[uid] = record;
  writeAll(all);
  console.log(
    '[auth/userStore] new dallyeori-only user (MONO 분리 저장소):',
    uid,
    'file:',
    USERS_FILE,
  );
  return { record, isFirstSeen: true };
}

/**
 * @param {string} uid
 */
export function markProfileSetupComplete(uid) {
  const all = readAll();
  const prev = all[uid] || { createdAt: Date.now() };
  all[uid] = {
    ...prev,
    profileSetupComplete: true,
    completedAt: Date.now(),
  };
  writeAll(all);
  console.log('[auth/userStore] profile complete (dallyeori only):', uid);
}
