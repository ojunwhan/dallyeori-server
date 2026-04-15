import { getDb } from './database.js';

/**
 * @param {string} playerUid
 * @param {{
 *   opponentUid?: string | null,
 *   opponentNick?: string,
 *   result?: string,
 *   myDistance?: number,
 *   opponentDistance?: number,
 *   duration?: number,
 * }} body
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function insertRaceResult(playerUid, body) {
  const me = typeof playerUid === 'string' ? playerUid.trim() : '';
  if (!me) return { ok: false, error: 'bad_uid' };
  const o = body && typeof body === 'object' ? body : {};
  const opponentUidRaw = o.opponentUid;
  const opponentUid =
    opponentUidRaw != null && String(opponentUidRaw).trim() ? String(opponentUidRaw).trim() : null;
  if (!opponentUid) return { ok: false, error: 'bad_opponent' };
  const opponentNick =
    typeof o.opponentNick === 'string' ? String(o.opponentNick).trim().slice(0, 200) : '';
  const resRaw = o.result;
  const result =
    resRaw === 'win' || resRaw === 'lose' || resRaw === 'draw' ? resRaw : null;
  if (!result) return { ok: false, error: 'bad_result' };
  const myDistance = Number(o.myDistance);
  const opponentDistance = Number(o.opponentDistance);
  const duration = Number(o.duration);
  if (!Number.isFinite(myDistance) || !Number.isFinite(opponentDistance) || !Number.isFinite(duration)) {
    return { ok: false, error: 'bad_numbers' };
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO race_results (
       player_uid, opponent_uid, opponent_nick, result,
       my_distance, opponent_distance, duration
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    me,
    opponentUid,
    opponentNick || null,
    result,
    myDistance,
    opponentDistance,
    duration,
  );
  return { ok: true };
}
