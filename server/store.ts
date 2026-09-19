import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export function openStore(dataDir: string) {
  mkdirSync(join(dataDir, 'objects'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDir, 'tmp'), { recursive: true, mode: 0o700 });
  const db = new Database(join(dataDir, 'vault.sqlite'));
  chmodSync(join(dataDir, 'vault.sqlite'), 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
      transports TEXT NOT NULL, label TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','viewer')),
      ip TEXT NOT NULL, created INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, credential_id TEXT NOT NULL REFERENCES credentials(id),
      created INTEGER NOT NULL, touched INTEGER NOT NULL, ip TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS challenges (
      hash TEXT PRIMARY KEY, kind TEXT NOT NULL, challenge TEXT NOT NULL,
      context TEXT NOT NULL, ip TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invitations (
      hash TEXT PRIMARY KEY, role TEXT NOT NULL, ip TEXT NOT NULL,
      expires INTEGER NOT NULL, issuer TEXT NOT NULL REFERENCES credentials(id)
    );
    CREATE TABLE IF NOT EXISTS vault (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), envelope TEXT NOT NULL,
      catalog TEXT NOT NULL, revision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS current_objects (id TEXT PRIMARY KEY REFERENCES objects(id));
    CREATE TABLE IF NOT EXISTS pending_deletions (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS device_preferences (
      credential_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
      sort_order TEXT NOT NULL CHECK(sort_order IN ('date-desc','date-asc','name-asc','name-desc'))
    );
    PRAGMA user_version = 3;
  `);
  return db;
}
