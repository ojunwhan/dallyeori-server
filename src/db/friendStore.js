import { getDb } from './database.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} a
 * @param {string} b
 */
function isAcceptedPair(db, a, b) {
  const r = db
    .prepare(
      `SELECT 1 AS ok FROM friends WHERE status = 'accepted'
       AND ((requester_uid = ? AND receiver_uid = ?) OR (requester_uid = ? AND receiver_uid = ?))
       LIMIT 1`,
    )
    .get(a, b, b, a);
  return Boolean(r);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} requester
 * @param {string} receiver
 */
function hasPendingOutgoing(db, requester, receiver) {
  const r = db
    .prepare(
      `SELECT 1 FROM friends WHERE requester_uid = ? AND receiver_uid = ? AND status = 'pending' LIMIT 1`,
    )
    .get(requester, receiver);
  return Boolean(r);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} me
 * @param {string} peer
 */
function hasPendingIncoming(db, me, peer) {
  const r = db
    .prepare(
      `SELECT 1 FROM friends WHERE requester_uid = ? AND receiver_uid = ? AND status = 'pending' LIMIT 1`,
    )
    .get(peer, me);
  return Boolean(r);
}

const MAX_SEARCH_ROWS = 400;

/**
 * @param {string} meUid
 * @param {{
 *   q?: string,
 *   countryCode?: string,
 *   gender?: string,
 *   offset?: number,
 *   limit?: number,
 *   onlineUids?: Set<string>,
 * }} params
 * @returns {{ users: object[], hasMore: boolean }}
 */
export function searchUsersDiscovery(meUid, params) {
  const db = getDb();
  const q = typeof params.q === 'string' ? params.q.trim() : '';
  const countryCode = String(params.countryCode || '')
    .trim()
    .toUpperCase();
  const gender = String(params.gender || '')
    .trim()
    .toUpperCase();
  const offset = Math.max(0, Math.floor(Number(params.offset)) || 0);
  const limit = Math.min(50, Math.max(1, Math.floor(Number(params.limit)) || 10));
  const onlineUids = params.onlineUids instanceof Set ? params.onlineUids : new Set();

  let sql = `SELECT uid, nickname, language, country_code AS countryCode, gender
             FROM user_profiles
             WHERE uid != ?
               AND nickname IS NOT NULL
               AND TRIM(nickname) != ''
               AND LENGTH(TRIM(nickname)) >= 2`;
  const args = [meUid];

  if (q) {
    sql += ` AND instr(lower(nickname), lower(?)) > 0`;
    args.push(q);
  }
  if (countryCode && /^[A-Z]{2}$/.test(countryCode)) {
    sql += ` AND upper(trim(country_code)) = ?`;
    args.push(countryCode);
  }
  if (gender === 'M' || gender === 'F') {
    sql += ` AND upper(trim(gender)) = ?`;
    args.push(gender);
  }

  sql += ` ORDER BY lower(nickname) COLLATE NOCASE LIMIT ?`;
  args.push(MAX_SEARCH_ROWS);

  const rows = db.prepare(sql).all(...args);

  const enriched = rows.map((r) => {
    const uid = String(r.uid);
    const cc = r.countryCode != null ? String(r.countryCode).trim().toUpperCase() : '';
    const countryNorm = /^[A-Z]{2}$/.test(cc) ? cc : '';
    const gRaw = r.gender != null ? String(r.gender).trim().toUpperCase() : '';
    const genderVal = gRaw === 'M' || gRaw === 'F' ? gRaw : null;
    return {
      uid,
      nickname: String(r.nickname ?? ''),
      language: String(r.language ?? 'ko'),
      countryCode: countryNorm,
      gender: genderVal,
      isOnline: onlineUids.has(uid),
      isFriend: isAcceptedPair(db, meUid, uid),
      isRequested: hasPendingOutgoing(db, meUid, uid),
    };
  });

  enriched.sort((a, b) => {
    const o = Number(b.isOnline) - Number(a.isOnline);
    if (o !== 0) return o;
    return String(a.nickname).localeCompare(String(b.nickname), undefined, { sensitivity: 'base' });
  });

  const slice = enriched.slice(offset, offset + limit);
  return { users: slice };
}

/**
 * @param {string} requesterUid
 * @param {string} receiverUid
 * @returns {{ ok: true, duplicate?: boolean } | { ok: false, error: string }}
 */
export function createFriendRequest(requesterUid, receiverUid) {
  const req = typeof requesterUid === 'string' ? requesterUid.trim() : '';
  const recv = typeof receiverUid === 'string' ? receiverUid.trim() : '';
  if (!req || !recv || req === recv) return { ok: false, error: 'bad_uid' };
  const db = getDb();
  if (isAcceptedPair(db, req, recv)) return { ok: true, duplicate: true };
  if (hasPendingOutgoing(db, req, recv)) return { ok: true, duplicate: true };
  if (hasPendingIncoming(db, req, recv)) return { ok: false, error: 'incoming_pending' };
  try {
    db.prepare(`INSERT INTO friends (requester_uid, receiver_uid, status) VALUES (?, ?, 'pending')`).run(
      req,
      recv,
    );
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? String(/** @type {{ code?: string }} */ (e).code) : '';
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') return { ok: true, duplicate: true };
    throw e;
  }
  return { ok: true };
}
