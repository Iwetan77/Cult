import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { env } from '../config/env.js';

let db: DatabaseSync | undefined;

export function getDb(path = env.dbPath): DatabaseSync {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(d: DatabaseSync) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS members (
      user_id          TEXT PRIMARY KEY,          -- Privy DID
      wallet           TEXT NOT NULL UNIQUE,      -- lowercased EVM address (Privy embedded wallet)
      privy_wallet_id  TEXT,                      -- Privy wallet id, for server-side signing under policy
      perpl_account_id INTEGER,
      api_key          TEXT,                      -- Perpl X-API-Key token
      api_key_secret   TEXT,                      -- sealed Ed25519 secret, see store/crypto.ts
      api_key_pubkey   TEXT,
      forwarding       INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL
    );
  `);
}
