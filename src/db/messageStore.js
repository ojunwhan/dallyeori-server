import { getDb } from './database.js';

/**
 * @param {string} uidA
 * @param {string} uidB
 */
export function roomKeyFor(uidA, uidB) {
  return [uidA, uidB].sort().join(':');
}

/**
 * @param {string} createdAt SQLite datetime string
 */
function createdAtToMs(createdAt) {
  if (!createdAt || typeof createdAt !== 'string') return Date.now();
  const normalized = createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : Date.now();
}

/**
 * @param {Record<string, unknown> | undefined} row
 */
function rowFromGet(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: Number(row.id),
    roomKey: String(row.roomKey),
    fromUid: String(row.fromUid),
    toUid: String(row.toUid),
    text: String(row.text),
    translatedText: row.translatedText != null ? String(row.translatedText) : null,
    fromLang: row.fromLang != null ? String(row.fromLang) : null,
    toLang: row.toLang != null ? String(row.toLang) : null,
    createdAt: String(row.createdAt),
    readAt: row.readAt != null ? String(row.readAt) : null,
  };
}

/**
 * @param {{
 *   fromUid: string,
 *   toUid: string,
 *   text: string,
 *   translatedText?: string | null,
 *   fromLang?: string | null,
 *   toLang?: string | null,
 * }} p
 */
export function saveMessage(p) {
  const db = getDb();
  const roomKey = roomKeyFor(p.fromUid, p.toUid);
  const tr =
    p.translatedText != null && String(p.translatedText).trim()
      ? String(p.translatedText).trim().slice(0, 2000)
      : null;
  const fromLang = p.fromLang != null ? String(p.fromLang).slice(0, 32) : null;
  const toLang = p.toLang != null ? String(p.toLang).slice(0, 32) : null;
  const info = db
    .prepare(
      `INSERT INTO messages (roomKey, fromUid, toUid, text, translatedText, fromLang, toLang)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(roomKey, p.fromUid, p.toUid, p.text, tr, fromLang, toLang);
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid));
  return rowFromGet(row);
}

/**
 * @param {string} uid1
 * @param {string} uid2
 * @param {number} [limit]
 * @param {number | null} [beforeId]
 */
export function getMessages(uid1, uid2, limit = 50, beforeId = null) {
  const db = getDb();
  const roomKey = roomKeyFor(uid1, uid2);
  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  if (beforeId != null && Number.isFinite(beforeId)) {
    const rows = db
      .prepare(
        `SELECT * FROM messages WHERE roomKey = ? AND id < ? ORDER BY id DESC LIMIT ?`,
      )
      .all(roomKey, beforeId, lim);
    return rows.map((r) => rowFromGet(r)).filter(Boolean);
  }
  const rows = db
    .prepare(`SELECT * FROM messages WHERE roomKey = ? ORDER BY id DESC LIMIT ?`)
    .all(roomKey, lim);
  return rows.map((r) => rowFromGet(r)).filter(Boolean);
}

/**
 * @param {string} toUid 수신자 uid
 */
export function getUnreadMessages(toUid) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE toUid = ? AND readAt IS NULL ORDER BY id ASC`,
    )
    .all(toUid);
  return rows.map((r) => rowFromGet(r)).filter(Boolean);
}

/**
 * 수신자(toUid)가 발신자(fromUid)에게 온 미읽음 메시지를 읽음 처리
 * @param {string} toUid 읽는 사람 (JWT 주체)
 * @param {string} fromUid 상대방
 * @returns {number} 변경된 행 수
 */
export function markAsRead(toUid, fromUid) {
  const db = getDb();
  const roomKey = roomKeyFor(toUid, fromUid);
  const r = db
    .prepare(
      `UPDATE messages SET readAt = datetime('now')
       WHERE roomKey = ? AND toUid = ? AND fromUid = ? AND readAt IS NULL`,
    )
    .run(roomKey, toUid, fromUid);
  return r.changes;
}

/**
 * DB 행 → 소켓/REST용 메시지 객체
 * @param {Exclude<ReturnType<typeof rowFromGet>, null>} row
 */
export function rowToClientMessage(row) {
  return {
    id: row.id,
    fromId: row.fromUid,
    toId: row.toUid,
    text: row.text,
    originalText: row.text,
    translatedText: row.translatedText || undefined,
    ts: createdAtToMs(row.createdAt),
    roomKey: row.roomKey,
    createdAt: row.createdAt,
    readAt: row.readAt || undefined,
  };
}
