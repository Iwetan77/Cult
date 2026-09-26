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

    CREATE TABLE IF NOT EXISTS clans (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      created_by  TEXT NOT NULL REFERENCES members(user_id),
      created_at  INTEGER NOT NULL
    );

    -- Mirror policy is set once at join and never re-asked per trade.
    CREATE TABLE IF NOT EXISTS clan_members (
      clan_id             TEXT NOT NULL REFERENCES clans(id),
      user_id             TEXT NOT NULL REFERENCES members(user_id),
      mirror_enabled      INTEGER NOT NULL DEFAULT 1,
      balance_percent_cap REAL NOT NULL,   -- max % of free Perpl balance a single mirror may use as margin
      max_usd_per_trade   REAL NOT NULL,   -- max notional (size x price) of a single mirrored position, USD
      joined_at           INTEGER NOT NULL,
      PRIMARY KEY (clan_id, user_id)
    );

    -- The signed "yes, mirror me" a member gives once at join, with the exact
    -- policy text they signed. Evidence of consent; never re-asked per trade.
    CREATE TABLE IF NOT EXISTS join_consents (
      clan_id    TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      message    TEXT NOT NULL,
      signature  TEXT NOT NULL,
      signed_at  INTEGER NOT NULL,
      PRIMARY KEY (clan_id, user_id)
    );

    -- A position a member opened themselves (not placed by our engine).
    CREATE TABLE IF NOT EXISTS leader_trades (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES members(user_id),
      account_id      INTEGER NOT NULL,
      market_id       INTEGER NOT NULL,
      side            TEXT NOT NULL,
      position_id     INTEGER NOT NULL,
      size            INTEGER NOT NULL,     -- scaled
      entry_price     INTEGER NOT NULL,     -- scaled
      leverage        INTEGER NOT NULL,     -- hundredths
      margin_fraction REAL NOT NULL,        -- position collateral / (free balance + collateral) at open
      open_tx         TEXT,
      opened_at       INTEGER NOT NULL,
      closed_at       INTEGER,
      UNIQUE (account_id, position_id)
    );

    CREATE TABLE IF NOT EXISTS mirrors (
      id            TEXT PRIMARY KEY,
      trade_id      TEXT NOT NULL REFERENCES leader_trades(id),
      clan_id       TEXT NOT NULL REFERENCES clans(id),
      user_id       TEXT NOT NULL REFERENCES members(user_id),
      status        TEXT NOT NULL,   -- pending|skipped|submitting|open|closed|failed|cancelled
      skip_until    INTEGER NOT NULL,
      margin_usd    REAL,
      notional_usd  REAL,
      size          INTEGER,         -- scaled, as filled
      cap_applied   TEXT,            -- which limit bound the size, if any
      open_rq       INTEGER,
      open_oid      INTEGER,
      open_tx       TEXT,
      close_rq      INTEGER,
      close_oid     INTEGER,
      close_tx      TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      UNIQUE (trade_id, user_id)
    );

    -- Manual stack: an explicit member action on someone else's marker. Kept
    -- apart from mirrors on purpose; it never triggers auto-mirror itself.
    CREATE TABLE IF NOT EXISTS stacks (
      id            TEXT PRIMARY KEY,
      clan_id       TEXT NOT NULL REFERENCES clans(id),
      user_id       TEXT NOT NULL REFERENCES members(user_id),
      target_trade  TEXT NOT NULL REFERENCES leader_trades(id),
      market_id     INTEGER NOT NULL,
      side          TEXT NOT NULL,
      size          INTEGER,
      notional_usd  REAL,
      leverage      INTEGER NOT NULL,
      status        TEXT NOT NULL,   -- submitting|open|failed
      open_rq       INTEGER,
      open_oid      INTEGER,
      open_tx       TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL
    );

    -- Every request id our engine sends, so positions it opens are never
    -- mistaken for a member's own trade (which would mirror the mirror).
    CREATE TABLE IF NOT EXISTS engine_orders (
      account_id INTEGER NOT NULL,
      rq         INTEGER NOT NULL,
      kind       TEXT NOT NULL,       -- mirror_open|mirror_close|stack_open
      ref_id     TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, rq)
    );
  `);
}
