import fs from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DATA_DIR = process.env.DALLYEORI_DATA_DIR || join(process.cwd(), 'data');
const FILE_PATH = join(DATA_DIR, 'dallyeori-friend-requests.json');

/**
 * @typedef {{
 *   id: string,
 *   fromUid: string,
 *   toUid: string,
 *   fromName: string,
 *   toName: string,
 *   status: 'pending' | 'accepted' | 'rejected',
 *   createdAt: string,
 *   respondedAt: string | null,
 *   readByFrom: boolean,
 * }} FriendRequestRecord
 */

/** @returns {{ requests: FriendRequestRecord[] }} */
function emptyDoc() {
  return { requests: [] };
}

/** @returns {{ requests: FriendRequestRecord[] }} */
export function readFriendRequestsDoc() {
  try {
    mkdirSync(dirname(FILE_PATH), { recursive: true });
    if (!fs.existsSync(FILE_PATH)) return emptyDoc();
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    const o = JSON.parse(raw);
    const arr = o && Array.isArray(o.requests) ? o.requests : [];
    return { requests: /** @type {FriendRequestRecord[]} */ (arr) };
  } catch (e) {
    console.warn('[friendRequestsJsonStore] read failed, reset empty', e);
    return emptyDoc();
  }
}

/** @param {{ requests: FriendRequestRecord[] }} doc */
function writeFriendRequestsDoc(doc) {
  mkdirSync(dirname(FILE_PATH), { recursive: true });
  const tmp = `${FILE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 0), 'utf8');
  fs.renameSync(tmp, FILE_PATH);
}

/**
 * 동일 from→to pending 존재 여부
 * @param {string} fromUid
 * @param {string} toUid
 */
export function hasPendingFromTo(fromUid, toUid) {
  const f = typeof fromUid === 'string' ? fromUid.trim() : '';
  const t = typeof toUid === 'string' ? toUid.trim() : '';
  if (!f || !t) return false;
  const { requests } = readFriendRequestsDoc();
  return requests.some((r) => r.fromUid === f && r.toUid === t && r.status === 'pending');
}

/**
 * @param {Omit<FriendRequestRecord, 'respondedAt' | 'readByFrom'> & { respondedAt?: null, readByFrom?: boolean }} rec
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function insertPendingRequest(rec) {
  const id = typeof rec.id === 'string' ? rec.id.trim() : '';
  const fromUid = typeof rec.fromUid === 'string' ? rec.fromUid.trim() : '';
  const toUid = typeof rec.toUid === 'string' ? rec.toUid.trim() : '';
  if (!id || !fromUid || !toUid || fromUid === toUid) return { ok: false, error: 'bad_request' };
  if (hasPendingFromTo(fromUid, toUid)) return { ok: false, error: 'duplicate_pending' };

  const doc = readFriendRequestsDoc();
  if (doc.requests.some((r) => r.id === id)) return { ok: false, error: 'id_exists' };

  /** @type {FriendRequestRecord} */
  const row = {
    id,
    fromUid,
    toUid,
    fromName: typeof rec.fromName === 'string' ? rec.fromName.trim() : '',
    toName: typeof rec.toName === 'string' ? rec.toName.trim() : '',
    status: 'pending',
    createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : new Date().toISOString(),
    respondedAt: null,
    readByFrom: false,
  };
  doc.requests.push(row);
  writeFriendRequestsDoc(doc);
  return { ok: true };
}

/** @param {string} id */
export function getRequestById(id) {
  const rid = typeof id === 'string' ? id.trim() : '';
  if (!rid) return null;
  const { requests } = readFriendRequestsDoc();
  return requests.find((r) => r.id === rid) ?? null;
}

/**
 * @param {string} requestId
 * @param {string} accepterUid
 * @returns {{ ok: true, rec: FriendRequestRecord } | { ok: false, error: string }}
 */
export function markAccepted(requestId, accepterUid) {
  const uid = typeof accepterUid === 'string' ? accepterUid.trim() : '';
  const doc = readFriendRequestsDoc();
  const idx = doc.requests.findIndex((r) => r.id === requestId.trim());
  if (idx === -1) return { ok: false, error: 'not_found' };
  const r = doc.requests[idx];
  if (r.toUid !== uid) return { ok: false, error: 'forbidden' };
  if (r.status !== 'pending') return { ok: false, error: 'bad_state' };
  const now = new Date().toISOString();
  r.status = 'accepted';
  r.respondedAt = now;
  writeFriendRequestsDoc(doc);
  return { ok: true, rec: r };
}

/**
 * @param {string} requestId
 * @param {string} rejecterUid
 * @returns {{ ok: true, rec: FriendRequestRecord } | { ok: false, error: string }}
 */
export function markRejected(requestId, rejecterUid) {
  const uid = typeof rejecterUid === 'string' ? rejecterUid.trim() : '';
  const doc = readFriendRequestsDoc();
  const idx = doc.requests.findIndex((r) => r.id === requestId.trim());
  if (idx === -1) return { ok: false, error: 'not_found' };
  const r = doc.requests[idx];
  if (r.toUid !== uid) return { ok: false, error: 'forbidden' };
  if (r.status !== 'pending') return { ok: false, error: 'bad_state' };
  const now = new Date().toISOString();
  r.status = 'rejected';
  r.respondedAt = now;
  writeFriendRequestsDoc(doc);
  return { ok: true, rec: r };
}

/**
 * @param {string} myUid
 * @returns {{ pendingReceived: FriendRequestRecord[], unreadResults: FriendRequestRecord[] }}
 */
export function listNotificationsForUid(myUid) {
  const me = typeof myUid === 'string' ? myUid.trim() : '';
  if (!me) return { pendingReceived: [], unreadResults: [] };
  const { requests } = readFriendRequestsDoc();
  const pendingReceived = requests.filter((r) => r.toUid === me && r.status === 'pending');
  const unreadResults = requests.filter(
    (r) =>
      r.fromUid === me &&
      (r.status === 'accepted' || r.status === 'rejected') &&
      r.readByFrom === false,
  );
  return { pendingReceived, unreadResults };
}

/**
 * @param {string} myUid
 * @param {string[]} requestIds
 * @returns {number} updated count
 */
export function markReadByFrom(myUid, requestIds) {
  const me = typeof myUid === 'string' ? myUid.trim() : '';
  const ids = Array.isArray(requestIds)
    ? requestIds.map((x) => String(x).trim()).filter(Boolean)
    : [];
  if (!me || ids.length === 0) return 0;
  const doc = readFriendRequestsDoc();
  let n = 0;
  for (const r of doc.requests) {
    if (r.fromUid !== me) continue;
    if (!ids.includes(r.id)) continue;
    if (r.readByFrom) continue;
    r.readByFrom = true;
    n += 1;
  }
  if (n > 0) writeFriendRequestsDoc(doc);
  return n;
}
