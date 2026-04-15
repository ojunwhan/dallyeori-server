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
 * ISO 3166-1 alpha-2: 빈 문자열 허용, 아니면 정확히 2글자 A–Z
 * @param {unknown} raw
 * @returns {{ ok: true, value: string } | { ok: false, code: string }}
 */
export function validateCountryCode(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: '' };
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (s === '') return { ok: true, value: '' };
  if (!/^[A-Z]{2}$/.test(s)) return { ok: false, code: 'bad_country_code' };
  return { ok: true, value: s };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: string | null } | { ok: false, code: string }}
 */
export function validateGender(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  const g = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (g === '') return { ok: true, value: null };
  if (g === 'M' || g === 'F' || g === 'X') return { ok: true, value: g };
  return { ok: false, code: 'bad_gender' };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: string | null } | { ok: false, code: string }}
 */
export function validateBio(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (t === '') return { ok: true, value: null };
  if (t.length > 100) return { ok: false, code: 'bad_bio' };
  return { ok: true, value: t };
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
 * @param {string | null | undefined} sqliteDt
 * @returns {string | null}
 */
function sqliteDatetimeToIso(sqliteDt) {
  if (!sqliteDt || typeof sqliteDt !== 'string') return null;
  const s = sqliteDt.trim();
  if (!s) return null;
  const normalized = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(normalized);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/**
 * @param {string} uid
 * @returns {boolean} ISO 국가 2자리가 채워졌는지 (서버 프로필 완료 조건)
 */
export function isServerProfileComplete(uid) {
  if (!uid || typeof uid !== 'string') return false;
  const p = getProfile(uid);
  if (!p) return false;
  const c = String(p.countryCode || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c);
}

/**
 * @param {string} uid
 * @returns {number} 변경 행 수 (0 = 프로필 행 없음, no-op)
 */
export function updateLastSeen(uid) {
  if (!uid || typeof uid !== 'string') return 0;
  const db = getDb();
  const r = db
    .prepare(
      `UPDATE user_profiles SET last_seen_at = datetime('now'), updatedAt = datetime('now') WHERE uid = ?`,
    )
    .run(uid);
  return r.changes;
}

/**
 * @param {string} uid
 * @returns {{ uid: string, nickname: string | null, photoURL: string, language: string, selectedDuckId: string, countryCode: string, gender: string | null, bio: string | null, createdAt: string, updatedAt: string, lastSeenAt: string | null } | null}
 */
export function getProfile(uid) {
  if (!uid) return null;
  const db = getDb();
  const r = db.prepare(`SELECT * FROM user_profiles WHERE uid = ?`).get(uid);
  if (!r) return null;
  const genderRaw = r.gender != null ? String(r.gender).trim().toUpperCase() : '';
  const gender =
    genderRaw === 'M' || genderRaw === 'F' || genderRaw === 'X' ? genderRaw : null;
  const countryRaw = r.country_code != null ? String(r.country_code).trim().toUpperCase() : '';
  const countryCode = countryRaw === '' ? '' : countryRaw.length === 2 ? countryRaw : '';
  return {
    uid: String(r.uid),
    nickname: r.nickname != null && String(r.nickname).trim() ? String(r.nickname) : null,
    photoURL: String(r.photoURL ?? ''),
    language: String(r.language ?? 'ko'),
    selectedDuckId: String(r.selectedDuckId ?? 'bori'),
    countryCode,
    gender,
    bio: r.bio != null && String(r.bio).trim() ? String(r.bio).trim() : null,
    createdAt: String(r.createdAt ?? ''),
    updatedAt: String(r.updatedAt ?? ''),
    lastSeenAt: r.last_seen_at != null ? String(r.last_seen_at) : null,
  };
}

/**
 * @param {string} uid
 * @param {{
 *   nickname: string | null,
 *   photoURL?: string,
 *   language?: string,
 *   selectedDuckId?: string,
 *   countryCode?: string,
 *   gender?: string | null,
 *   bio?: string | null,
 * }} fields
 */
export function upsertProfile(uid, fields) {
  const nick =
    typeof fields.nickname === 'string' && fields.nickname.trim()
      ? fields.nickname.trim()
      : null;
  const photo = typeof fields.photoURL === 'string' ? fields.photoURL : '';
  const lang = typeof fields.language === 'string' && fields.language.trim() ? fields.language.trim() : 'ko';
  const duck =
    typeof fields.selectedDuckId === 'string' && fields.selectedDuckId.trim()
      ? fields.selectedDuckId.trim()
      : 'bori';
  const countryCode =
    typeof fields.countryCode === 'string' ? fields.countryCode.trim().toUpperCase() : '';
  const genderNorm = fields.gender;
  const gender =
    genderNorm === 'M' || genderNorm === 'F' || genderNorm === 'X'
      ? genderNorm
      : null;
  const bioVal = fields.bio != null && String(fields.bio).trim() ? String(fields.bio).trim() : null;

  const db = getDb();
  db.prepare(
    `INSERT INTO user_profiles (uid, nickname, photoURL, language, selectedDuckId, country_code, gender, bio, last_seen_at, createdAt, updatedAt)
     VALUES (@uid, @nickname, @photoURL, @language, @selectedDuckId, @country_code, @gender, @bio, datetime('now'), datetime('now'), datetime('now'))
     ON CONFLICT(uid) DO UPDATE SET
       nickname = excluded.nickname,
       photoURL = excluded.photoURL,
       language = excluded.language,
       selectedDuckId = excluded.selectedDuckId,
       country_code = excluded.country_code,
       gender = excluded.gender,
       bio = excluded.bio,
       updatedAt = datetime('now')`,
  ).run({
    uid,
    nickname: nick,
    photoURL: photo,
    language: lang,
    selectedDuckId: duck,
    country_code: countryCode,
    gender,
    bio: bioVal,
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

  const existing = getProfile(uid);

  const countryRaw = o.countryCode !== undefined ? o.countryCode : (existing?.countryCode ?? '');
  const cv = validateCountryCode(countryRaw);
  if (!cv.ok) return { status: 400, error: cv.code, profile: null };

  const genderRaw = o.gender !== undefined ? o.gender : existing?.gender ?? null;
  const gv = validateGender(genderRaw);
  if (!gv.ok) return { status: 400, error: gv.code, profile: null };

  const bioRaw = o.bio !== undefined ? o.bio : existing?.bio ?? null;
  const bv = validateBio(bioRaw);
  if (!bv.ok) return { status: 400, error: bv.code, profile: null };

  const photoURL =
    typeof o.photoURL === 'string' ? o.photoURL : (existing?.photoURL ?? '');
  const language =
    typeof o.language === 'string' && o.language.trim()
      ? o.language.trim()
      : (existing?.language ?? 'ko') || 'ko';
  const selectedDuckId =
    typeof o.selectedDuckId === 'string' && o.selectedDuckId.trim()
      ? o.selectedDuckId.trim()
      : (existing?.selectedDuckId ?? 'bori') || 'bori';

  try {
    upsertProfile(uid, {
      nickname: v.nickname,
      photoURL,
      language,
      selectedDuckId,
      countryCode: cv.value,
      gender: gv.value,
      bio: bv.value,
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
 * 클라이언트 응답용 (기존 POST /api/profile)
 * @param {NonNullable<ReturnType<typeof getProfile>>} p
 */
export function profileToClient(p) {
  return {
    uid: p.uid,
    nickname: p.nickname ?? '',
    photoURL: p.photoURL,
    language: p.language,
    selectedDuckId: p.selectedDuckId,
    countryCode: p.countryCode ?? '',
    gender: p.gender,
    bio: p.bio,
    lastSeenAt: sqliteDatetimeToIso(p.lastSeenAt),
  };
}

/**
 * @param {NonNullable<ReturnType<typeof getProfile>>} p
 */
export function profileToPublicV1(p) {
  return {
    uid: p.uid,
    nickname: p.nickname ?? '',
    photoURL: p.photoURL,
    selectedDuckId: p.selectedDuckId,
    countryCode: p.countryCode ?? '',
    gender: p.gender,
    bio: p.bio,
    language: p.language,
    lastSeenAt: sqliteDatetimeToIso(p.lastSeenAt),
  };
}
