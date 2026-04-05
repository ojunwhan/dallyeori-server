import { getDb } from './database.js';

/**
 * @param {string} uid
 * @returns {{ uid: string, balance: number }}
 */
export function getBalance(uid) {
  const db = getDb();
  let row = db.prepare('SELECT uid, balance FROM hearts WHERE uid = ?').get(uid);
  if (!row) {
    db.prepare('INSERT INTO hearts (uid, balance) VALUES (?, 50)').run(uid);
    row = { uid, balance: 50 };
  }
  return { uid: String(row.uid), balance: Number(row.balance) || 0 };
}

/**
 * @param {string} uid
 * @param {number} amount
 * @param {string} reason
 * @param {string | null | undefined} [relatedUid]
 * @returns {{ uid: string, balance: number }}
 */
export function addHearts(uid, amount, reason, relatedUid) {
  const db = getDb();
  getBalance(uid);
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0) return getBalance(uid);
  const rel = relatedUid != null && relatedUid !== '' ? String(relatedUid) : null;
  const rsn = String(reason || 'add').slice(0, 64);
  db.transaction(() => {
    db.prepare(
      `UPDATE hearts SET balance = balance + ?, updatedAt = datetime('now') WHERE uid = ?`,
    ).run(n, uid);
    db.prepare(
      `INSERT INTO heart_transactions (uid, amount, reason, relatedUid) VALUES (?, ?, ?, ?)`,
    ).run(uid, n, rsn, rel);
  })();
  return getBalance(uid);
}

/**
 * @param {string} uid
 * @param {number} amount
 * @param {string} reason
 * @param {string | null | undefined} [relatedUid]
 * @returns {{ success: true, balance: number } | { success: false, balance: number }}
 */
export function consumeHearts(uid, amount, reason, relatedUid) {
  const db = getDb();
  getBalance(uid);
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0) {
    return { success: false, balance: getBalance(uid).balance };
  }
  const rel = relatedUid != null && relatedUid !== '' ? String(relatedUid) : null;
  const rsn = String(reason || 'spend').slice(0, 64);
  /** @type {{ success: boolean, balance: number }} */
  const out = db.transaction(() => {
    const row = db.prepare('SELECT balance FROM hearts WHERE uid = ?').get(uid);
    const bal = Number(row?.balance) || 0;
    if (bal < n) {
      return { success: false, balance: bal };
    }
    db.prepare(
      `UPDATE hearts SET balance = balance - ?, updatedAt = datetime('now') WHERE uid = ?`,
    ).run(n, uid);
    db.prepare(
      `INSERT INTO heart_transactions (uid, amount, reason, relatedUid) VALUES (?, ?, ?, ?)`,
    ).run(uid, -n, rsn, rel);
    const after = db.prepare('SELECT balance FROM hearts WHERE uid = ?').get(uid);
    return { success: true, balance: Number(after?.balance) || 0 };
  })();
  return out;
}

/**
 * @param {string} uid
 * @param {number} [limit]
 */
export function getTransactions(uid, limit = 20) {
  const db = getDb();
  const lim = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 20));
  const rows = db
    .prepare(
      `SELECT id, amount, reason, relatedUid, createdAt
       FROM heart_transactions WHERE uid = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(uid, lim);
  return rows.map((r) => ({
    id: r.id,
    amount: r.amount,
    reason: r.reason,
    relatedUid: r.relatedUid ?? null,
    createdAt: r.createdAt,
  }));
}
