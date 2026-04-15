import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.DALLYEORI_DATA_DIR || join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, 'dallyeori.db');

/** @type {import('better-sqlite3').Database | null} */
let _db = null;

/**
 * @param {import('better-sqlite3').Database} db
 */
function runProfileMigrations(db) {
  const alters = [
    `ALTER TABLE user_profiles ADD COLUMN country_code TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE user_profiles ADD COLUMN gender TEXT`,
    `ALTER TABLE user_profiles ADD COLUMN bio TEXT`,
    `ALTER TABLE user_profiles ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT ''`,
  ];
  for (const sql of alters) {
    try {
      db.prepare(sql).run();
    } catch (e) {
      const msg = String(e && typeof e === 'object' && 'message' in e ? e.message : e);
      if (!msg.includes('duplicate column')) throw e;
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_profiles_country ON user_profiles(country_code);
    CREATE INDEX IF NOT EXISTS idx_user_profiles_gender ON user_profiles(gender);
    CREATE INDEX IF NOT EXISTS idx_user_profiles_last_seen ON user_profiles(last_seen_at);
  `);
}

/**
 * @returns {import('better-sqlite3').Database}
 */
export function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roomKey TEXT NOT NULL,
      fromUid TEXT NOT NULL,
      toUid TEXT NOT NULL,
      text TEXT NOT NULL,
      translatedText TEXT,
      fromLang TEXT,
      toLang TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      readAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_roomKey ON messages(roomKey);
    CREATE INDEX IF NOT EXISTS idx_messages_toUid_readAt ON messages(toUid, readAt);
    CREATE TABLE IF NOT EXISTS hearts (
      uid TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 50,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS heart_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      relatedUid TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_heart_tx_uid ON heart_transactions(uid);
    CREATE TABLE IF NOT EXISTS daily_free_hearts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fromUid TEXT NOT NULL,
      toUid TEXT NOT NULL,
      sentDate TEXT NOT NULL,
      UNIQUE(fromUid, toUid, sentDate)
    );
    CREATE TABLE IF NOT EXISTS user_profiles (
      uid TEXT PRIMARY KEY,
      nickname TEXT,
      photoURL TEXT,
      language TEXT DEFAULT 'ko',
      selectedDuckId TEXT DEFAULT 'bori',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_nickname ON user_profiles(nickname COLLATE NOCASE);
  `);
  runProfileMigrations(_db);
  runFriendMigrations(_db);
  return _db;
}

/**
 * 친구 요청(검색·요청 API용)
 * @param {import('better-sqlite3').Database} db
 */
function runFriendMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_uid TEXT NOT NULL,
      receiver_uid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_friends_requester_receiver ON friends(requester_uid, receiver_uid);
    CREATE INDEX IF NOT EXISTS idx_friends_status ON friends(status);
  `);
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_pair_unique ON friends(requester_uid, receiver_uid)`,
    );
  } catch (e) {
    const msg = String(e && typeof e === 'object' && 'message' in e ? e.message : e);
    console.warn('[db] friends pair unique index:', msg);
  }
}

getDb();
