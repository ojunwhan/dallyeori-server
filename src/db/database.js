import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.DALLYEORI_DATA_DIR || join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, 'dallyeori.db');

/** @type {import('better-sqlite3').Database | null} */
let _db = null;

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
  `);
  return _db;
}

getDb();
