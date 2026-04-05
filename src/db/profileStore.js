import { getDb } from './database.js';

/**
 * 닉네임: 2~12자, 한글·영문·숫자만
 * @param {unknown} nickname
 * @returns {{ ok: true, nickname: string } | { ok: false, code: string }}
 */
export function validateNicknameShape(nickname) {
  if (typeof nickname !== 'string') return { ok: false, code: 'bad_nickname' };
  const n = nickname.trim();
  if (n.length < 2 || n.length > 12) return { ok: false, code: 'bad_nickname' };
  if (!/^[\uAC00-\uD7A3a-zA-Z0-9]+$/.test(n)) return { ok: false, code: 'bad_nickname' };
  return { ok: true, nickname: n };
}

/**
 * @param {string} nickname
 * @param {string} excludeUid
 */
export function isNicknameTaken(nickname, excludeUid) {
  const n = typeof nickname === 'string' ? nickname.trim() : '';
  if (!n || !excludeUid) return false;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT uid FROM user_profiles WHERE nickname = ? COLLATE NOCASE AND uid != ? LIMIT 1`,
    )
    .get(n, excludeUid);
  return Boolean(row);
}

/**
 * @param {string} query
 * @param {string} excludeUid
 * @param {number} [limit]
 * @returns {{ uid: string, nickname: string, photoURL: string, selectedDuckId: string }[]}
 */
export function searchByNickname(query, excludeUid, limit = 10) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q || !excludeUid) return [];
  const lim = Math.min(50, Math.max(1, Math.floor(Number(limit)) || 10));
  const needle = q.toLowerCase();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT uid, nickname, photoURL, selectedDuckId FROM user_profiles
       WHERE uid != @excludeUid
         AND nickname IS NOT NULL
         AND TRIM(nickname) != ''
         AND instr(lower(nickname), @needle) > 0
       LIMIT @lim`,
    )
    .all({ excludeUid, needle, lim });
  return rows.map((r) => ({
    uid: String(r.uid),
    nickname: String(r.nickname ?? ''),
    photoURL: String(r.photoURL ?? ''),
    selectedDuckId: String(r.selectedDuckId ?? 'bori'),
  }));
}

/**
 * @param {string} uid
 * @returns {{ uid: string, nickname: string | null, photoURL: string, language: string, selectedDuckId: string, createdAt: string, updatedAt: string } | null}
 */
export function getProfile(uid) {
  if (!uid) return null;
  const db = getDb();
  const r = db.prepare(`SELECT * FROM user_profiles WHERE uid = ?`).get(uid);
  if (!r) return null;
  return {
    uid: String(r.uid),
    nickname: r.nickname != null && String(r.nickname).trim() ? String(r.nickname) : null,
    photoURL: String(r.photoURL ?? ''),
    language: String(r.language ?? 'ko'),
    selectedDuckId: String(r.selectedDuckId ?? 'bori'),
    createdAt: String(r.createdAt ?? ''),
    updatedAt: String(r.updatedAt ?? ''),
  };
}

/**
 * @param {string} uid
 * @param {{ nickname: string, photoURL?: string, language?: string, selectedDuckId?: string }} fields
 */
export function upsertProfile(uid, fields) {
  const { nickname, photoURL = '', language = 'ko', selectedDuckId = 'bori' } = fields;
  const nick =
    typeof nickname === 'string' && nickname.trim() ? nickname.trim() : null;
  const photo = typeof photoURL === 'string' ? photoURL : '';
  const lang = typeof language === 'string' && language.trim() ? language.trim() : 'ko';
  const duck =
    typeof selectedDuckId === 'string' && selectedDuckId.trim()
      ? selectedDuckId.trim()
      : 'bori';
  const db = getDb();
  db.prepare(
    `INSERT INTO user_profiles (uid, nickname, photoURL, language, selectedDuckId, createdAt, updatedAt)
     VALUES (@uid, @nickname, @photoURL, @language, @selectedDuckId, datetime('now'), datetime('now'))
     ON CONFLICT(uid) DO UPDATE SET
       nickname = excluded.nickname,
       photoURL = excluded.photoURL,
       language = excluded.language,
       selectedDuckId = excluded.selectedDuckId,
       updatedAt = datetime('now')`,
  ).run({
    uid,
    nickname: nick,
    photoURL: photo,
    language: lang,
    selectedDuckId: duck,
  });
}

/**
 * API용: 검증·중복 검사 후 저장
 * @param {string} uid
 * @param {Record<string, unknown>} body
 */
export function trySaveProfileFromBody(uid, body) {
  const o = body && typeof body === 'object' ? body : {};
  const nickRaw = o.nickname;
  const v = validateNicknameShape(nickRaw);
  if (!v.ok) return { status: 400, error: v.code, profile: null };

  if (isNicknameTaken(v.nickname, uid)) {
    return { status: 409, error: 'nickname_taken', profile: null };
  }

  const photoURL =
    typeof o.photoURL === 'string' ? o.photoURL : '';
  const language =
    typeof o.language === 'string' && o.language.trim() ? o.language.trim() : 'ko';
  const selectedDuckId =
    typeof o.selectedDuckId === 'string' && o.selectedDuckId.trim()
      ? o.selectedDuckId.trim()
      : 'bori';

  try {
    upsertProfile(uid, {
      nickname: v.nickname,
      photoURL,
      language,
      selectedDuckId,
    });
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { status: 409, error: 'nickname_taken', profile: null };
    }
    throw e;
  }
  const profile = getProfile(uid);
  return { status: 200, error: null, profile };
}

/**
 * 클라이언트 응답용 (null 닉네임 제거)
 * @param {NonNullable<ReturnType<typeof getProfile>>} p
 */
export function profileToClient(p) {
  return {
    uid: p.uid,
    nickname: p.nickname ?? '',
    photoURL: p.photoURL,
    language: p.language,
    selectedDuckId: p.selectedDuckId,
  };
}
