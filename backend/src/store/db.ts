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
  switchChain(db, env.chainId);
  return db;
}

const SCHEMA_VERSION = 12;

function migrate(d: DatabaseSync) {
  const { user_version } = d.prepare('PRAGMA user_version').get() as { user_version: number };
  if (user_version < 2) {
    // v1 trade tables were perpl-only. Nothing but test data exists yet, so
    // rebuild them rather than carry a column-by-column migration.
    d.exec('DROP TABLE IF EXISTS mirrors; DROP TABLE IF EXISTS stacks; DROP TABLE IF EXISTS leader_trades; DROP TABLE IF EXISTS engine_orders;');
  }
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
      privy_policy_id  TEXT,                      -- this member's backend-signer policy (src/privy/policy.ts)
      privy_policy_cap INTEGER,                   -- the raw AUSD cap that policy was built with
      country          TEXT,                      -- ISO 3166 alpha-2 the member picked (their country room + leaderboard)
      username         TEXT,                      -- chosen at first sign-in; unique ignoring case
      avatar_at        INTEGER,                   -- when their photo last changed (cache-busts the avatar URL)
      created_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clans (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,       -- ABC-DEF (older cults may have a legacy code)
      created_by  TEXT NOT NULL REFERENCES members(user_id),
      created_at  INTEGER NOT NULL,
      visibility  TEXT NOT NULL DEFAULT 'private', -- private: code only | public: listed, anyone can join
      pinned_message_id TEXT                        -- the owner's pinned chat message
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

    -- A trade a member opened themselves (not placed by our engine), on
    -- either venue. perpl: market = market id, position_id/account_id set.
    -- nadfun: market = token address (lowercase), size = tokens (wei).
    CREATE TABLE IF NOT EXISTS leader_trades (
      id              TEXT PRIMARY KEY,
      venue           TEXT NOT NULL,          -- perpl | nadfun
      user_id         TEXT NOT NULL REFERENCES members(user_id),
      account_id      INTEGER,                -- perpl account id
      market          TEXT NOT NULL,
      side            TEXT NOT NULL,          -- long | short | buy
      position_id     INTEGER,                -- perpl position id
      size            TEXT NOT NULL,          -- raw, the leader's size now (follows their adds and partial exits)
      open_size       TEXT,                   -- raw, the size they opened with
      entry_price     REAL,                   -- AUSD per unit
      leverage        INTEGER NOT NULL,       -- hundredths (nadfun: 100)
      margin_fraction REAL NOT NULL,          -- share of the leader's free balance this trade used
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
      margin_usd    REAL,            -- AUSD
      notional_usd  REAL,            -- AUSD
      size          TEXT,            -- raw, as filled
      cap_applied   TEXT,
      open_rq       INTEGER,         -- perpl request id
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

    -- A leader adding to, or partly selling, a trade they lead. Each open
    -- mirror follows by the same ratio of its own size. Adds wait out the
    -- skip window like a new mirror; reductions go straight out, like exits.
    CREATE TABLE IF NOT EXISTS mirror_adjustments (
      id            TEXT PRIMARY KEY,
      mirror_id     TEXT NOT NULL REFERENCES mirrors(id),
      trade_id      TEXT NOT NULL REFERENCES leader_trades(id),
      clan_id       TEXT NOT NULL REFERENCES clans(id),
      user_id       TEXT NOT NULL REFERENCES members(user_id),
      kind          TEXT NOT NULL,   -- add | reduce
      ratio         REAL NOT NULL,   -- leader's size after / before the change
      status        TEXT NOT NULL,   -- pending|skipped|submitting|done|failed|cancelled
      skip_until    INTEGER NOT NULL,
      size_delta    TEXT,            -- raw, what the follower actually bought or sold
      notional_usd  REAL,
      rq            INTEGER,
      oid           INTEGER,
      tx            TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mirror_adjustments_mirror ON mirror_adjustments(mirror_id);

    -- Manual stack: an explicit member action on someone else's marker. Kept
    -- apart from mirrors on purpose; it never triggers auto-mirror itself.
    CREATE TABLE IF NOT EXISTS stacks (
      id            TEXT PRIMARY KEY,
      venue         TEXT NOT NULL,
      clan_id       TEXT NOT NULL REFERENCES clans(id),
      user_id       TEXT NOT NULL REFERENCES members(user_id),
      target_trade  TEXT NOT NULL REFERENCES leader_trades(id),
      market        TEXT NOT NULL,
      side          TEXT NOT NULL,
      size          TEXT,
      notional_usd  REAL,
      leverage      INTEGER NOT NULL,
      status        TEXT NOT NULL,   -- submitting|open|failed
      open_rq       INTEGER,
      open_oid      INTEGER,
      open_tx       TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL
    );

    -- Everything our engine sends, so what it opens is never mistaken for a
    -- member's own trade (which would mirror the mirror). Perpl orders are
    -- keyed by (account, request id), Nad.fun txs by hash.
    CREATE TABLE IF NOT EXISTS engine_orders (
      account_id INTEGER NOT NULL,
      rq         INTEGER NOT NULL,
      kind       TEXT NOT NULL,       -- mirror_open|mirror_close|stack_open
      ref_id     TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, rq)
    );
    -- v10: MON the gas wallet sent members for network fees (funding/gas.ts).
    CREATE TABLE IF NOT EXISTS gas_drips (
      wallet     TEXT NOT NULL,       -- lowercase
      amount_wei TEXT NOT NULL,
      tx_hash    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gas_drips_wallet ON gas_drips(wallet, created_at);
    CREATE TABLE IF NOT EXISTS engine_txs (
      tx_hash    TEXT PRIMARY KEY,    -- lowercase
      wallet     TEXT NOT NULL,
      kind       TEXT NOT NULL,
      ref_id     TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Public share cards. A frozen snapshot of one of the member's own
    -- markers at share time; clan identity only if they opted in.
    CREATE TABLE IF NOT EXISTS shares (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES members(user_id),
      marker_id    TEXT NOT NULL,
      include_clan INTEGER NOT NULL,
      clan_name    TEXT,
      snapshot     TEXT NOT NULL,       -- JSON, see api/shares.ts
      created_at   INTEGER NOT NULL
    );

    -- "Drag to suggest": a clan-mate proposes a TP/SL on someone's Perpl
    -- marker. Only the owner can turn it into real trigger orders.
    CREATE TABLE IF NOT EXISTS tpsl_suggestions (
      id           TEXT PRIMARY KEY,
      clan_id      TEXT NOT NULL REFERENCES clans(id),
      trade_id     TEXT NOT NULL REFERENCES leader_trades(id),
      marker_id    TEXT NOT NULL,
      from_user    TEXT NOT NULL REFERENCES members(user_id),
      take_profit  REAL,
      stop_loss    REAL,
      created_at   INTEGER NOT NULL
    );

    -- Clan group chat. Leaders say what they're about to do here, since
    -- their trades (and adds and partial sells) are mirrored.
    CREATE TABLE IF NOT EXISTS clan_messages (
      id          TEXT PRIMARY KEY,
      clan_id     TEXT NOT NULL REFERENCES clans(id),
      user_id     TEXT NOT NULL REFERENCES members(user_id),
      body        TEXT NOT NULL,
      reply_to    TEXT,
      marker_id   TEXT,               -- optional chart marker the message is about
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS clan_messages_clan ON clan_messages(clan_id, created_at);

    -- Every chat room: "global", "country:NG", "cult:<id>". Replaces
    -- clan_messages (copied over in the v3 -> v4 step below).
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          TEXT PRIMARY KEY,
      room        TEXT NOT NULL,
      user_id     TEXT NOT NULL REFERENCES members(user_id),
      body        TEXT NOT NULL,
      reply_to    TEXT,
      marker_id   TEXT,
      created_at  INTEGER NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'text'   -- text | system ("X joined", "X opened BTC long")
    );
    CREATE INDEX IF NOT EXISTS chat_messages_room ON chat_messages(room, created_at);

    -- Profile photos, small (resized in the browser before upload).
    CREATE TABLE IF NOT EXISTS avatars (
      user_id    TEXT PRIMARY KEY REFERENCES members(user_id),
      mime       TEXT NOT NULL,
      bytes      BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- How far the Nad.fun router log watcher has read.
    CREATE TABLE IF NOT EXISTS cursors (
      name  TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );

    -- A member's Polymarket account (predictions), on Polygon: their Deposit
    -- Wallet (owned by their Privy wallet), whether its trading approvals are
    -- in, their CLOB credentials, and the session key they authorized us to
    -- trade with (trade only, it can't withdraw). Independent of the Monad
    -- chain, so a chain switch leaves it alone.
    CREATE TABLE IF NOT EXISTS prediction_accounts (
      user_id             TEXT PRIMARY KEY REFERENCES members(user_id),
      owner               TEXT NOT NULL,      -- lowercased owner address (the member's wallet)
      deposit_wallet      TEXT NOT NULL,      -- lowercased Polymarket Deposit Wallet
      deployed            INTEGER NOT NULL DEFAULT 0,
      approvals           INTEGER NOT NULL DEFAULT 0,
      clob_creds          TEXT,               -- sealed JSON {key, secret, passphrase} for the owner
      session_address     TEXT,
      session_key         TEXT,               -- sealed private key of the session signer
      session_valid_until INTEGER,            -- unix seconds
      session_retry_at    INTEGER,            -- ms; authorization was refused, try again after this
      updated_at          INTEGER NOT NULL
    );

    -- Prediction bets placed through Cult. Shares are reconciled against
    -- Polymarket's own positions when listed.
    CREATE TABLE IF NOT EXISTS prediction_positions (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES members(user_id),
      market_id     TEXT NOT NULL,          -- Polymarket (Gamma) market id
      condition_id  TEXT NOT NULL,
      token_id      TEXT NOT NULL,          -- the outcome token held
      side          TEXT NOT NULL,          -- yes | no
      side_label    TEXT NOT NULL,          -- "Yes", or a team name
      event_slug    TEXT NOT NULL,
      event_title   TEXT NOT NULL,
      outcome_label TEXT NOT NULL,
      question      TEXT NOT NULL,
      image         TEXT,
      neg_risk      INTEGER NOT NULL DEFAULT 0,
      shares        REAL NOT NULL,
      cost_usd      REAL NOT NULL,
      cult_ids      TEXT,                   -- JSON array of cults it was posted to; NULL = all
      opened_at     INTEGER NOT NULL,
      closed_at     INTEGER,
      close_price   REAL,
      proceeds_usd  REAL
    );
    CREATE INDEX IF NOT EXISTS prediction_positions_user ON prediction_positions(user_id, closed_at);
    CREATE INDEX IF NOT EXISTS prediction_positions_event ON prediction_positions(event_slug, closed_at);

    -- Cross-chain moves through Aurora Intents (NEAR Intents 1Click): money in
    -- from another chain to the member's Monad wallet, or out to one. Keyed by
    -- the one-time deposit address the quote handed out.
    CREATE TABLE IF NOT EXISTS intent_swaps (
      deposit_address   TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL REFERENCES members(user_id),
      kind              TEXT NOT NULL,      -- deposit | withdraw
      origin_asset      TEXT NOT NULL,
      destination_asset TEXT NOT NULL,
      amount_in         TEXT NOT NULL,      -- raw, origin asset units
      amount_out_usd    REAL,
      recipient         TEXT NOT NULL,
      memo              TEXT,
      status            TEXT NOT NULL,      -- 1Click status (PENDING_DEPOSIT ... SUCCESS | REFUNDED | FAILED)
      deadline          TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS intent_swaps_user ON intent_swaps(user_id, created_at);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES members(user_id) ON DELETE CASCADE,
      subscription TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);
    CREATE TABLE IF NOT EXISTS push_events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_deliveries (
      event_id TEXT NOT NULL REFERENCES push_events(id) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
      clan_id TEXT,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (event_id, subscription_id)
    );

    -- Facts about this database itself, e.g. which chain its trading state is for.
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const hasCol = (table: string, col: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
  // v2 -> v3: leaders' adds and partial exits are mirrored.
  if (!hasCol('leader_trades', 'open_size')) d.exec('ALTER TABLE leader_trades ADD COLUMN open_size TEXT');
  // v3 -> v4: public cults, member countries, room-based chat (global / country / cult).
  if (!hasCol('clans', 'visibility')) d.exec("ALTER TABLE clans ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
  if (!hasCol('members', 'country')) d.exec('ALTER TABLE members ADD COLUMN country TEXT');
  // v4 -> v5: system messages in chat, a pinned message per cult.
  if (!hasCol('chat_messages', 'kind')) d.exec("ALTER TABLE chat_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'");
  if (!hasCol('clans', 'pinned_message_id')) d.exec('ALTER TABLE clans ADD COLUMN pinned_message_id TEXT');
  // v5 -> v6: usernames and profile photos.
  if (!hasCol('members', 'username')) d.exec('ALTER TABLE members ADD COLUMN username TEXT');
  if (!hasCol('members', 'avatar_at')) d.exec('ALTER TABLE members ADD COLUMN avatar_at INTEGER');
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS members_username ON members(lower(username)) WHERE username IS NOT NULL');
  // v6 -> v7: which rules a member's signer policy was built with (a rules
  // change re-issues it, like a cap change does).
  if (!hasCol('members', 'privy_policy_rules')) d.exec('ALTER TABLE members ADD COLUMN privy_policy_rules TEXT');
  // ...and which of the member's cults a trade was posted to (JSON array of ids;
  // NULL = every cult they're in).
  if (!hasCol('leader_trades', 'cult_ids')) d.exec('ALTER TABLE leader_trades ADD COLUMN cult_ids TEXT');
  // v10 -> v11: cult admins. Only admins' trades are shared with the cult;
  // the creator is always one and can make others admins.
  if (!hasCol('clan_members', 'role')) {
    d.exec("ALTER TABLE clan_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
    d.exec("UPDATE clan_members SET role = 'admin' WHERE user_id = (SELECT created_by FROM clans WHERE clans.id = clan_members.clan_id)");
  }
  // v8 -> v9: a 4-digit PIN per member (hashed, see store/pins.ts), with a
  // wrong-try count and a lock.
  if (!hasCol('members', 'pin_hash')) d.exec('ALTER TABLE members ADD COLUMN pin_hash TEXT');
  if (!hasCol('members', 'pin_failures')) d.exec('ALTER TABLE members ADD COLUMN pin_failures INTEGER NOT NULL DEFAULT 0');
  if (!hasCol('members', 'pin_locked_until')) d.exec('ALTER TABLE members ADD COLUMN pin_locked_until INTEGER');
  if (user_version < 4) {
    d.exec(`INSERT OR IGNORE INTO chat_messages (id, room, user_id, body, reply_to, marker_id, created_at)
            SELECT id, 'cult:' || clan_id, user_id, body, reply_to, marker_id, created_at FROM clan_messages`);
  }
  d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

// Trading state belongs to one chain. Perpl accounts and keys, signer policies
// (pinned to a chain id), trades, copies and block cursors from testnet mean
// nothing on mainnet. When the configured chain changes, reset those and keep
// the people: members, usernames, photos, countries, cults and chats. Auto-follow
// is switched off everywhere, so nobody copies with real money until they turn
// it on again themselves.
// A database from before this was tracked is a testnet one (10143).
export function switchChain(d: DatabaseSync, chainId: number): boolean {
  const row = d.prepare("SELECT value FROM meta WHERE key = 'chain_id'").get() as { value: string } | undefined;
  const was = Number(row?.value ?? 10143);
  if (was === chainId) {
    if (!row) d.prepare("INSERT INTO meta (key, value) VALUES ('chain_id', ?)").run(String(chainId));
    return false;
  }
  d.exec('BEGIN');
  try {
    d.exec(`
      DELETE FROM tpsl_suggestions;
      DELETE FROM shares;
      DELETE FROM mirror_adjustments;
      DELETE FROM mirrors;
      DELETE FROM stacks;
      DELETE FROM leader_trades;
      DELETE FROM engine_orders;
      DELETE FROM engine_txs;
      DELETE FROM cursors;
      UPDATE members SET perpl_account_id = NULL, api_key = NULL, api_key_secret = NULL, api_key_pubkey = NULL,
        forwarding = 0, privy_policy_id = NULL, privy_policy_cap = NULL, privy_policy_rules = NULL;
      UPDATE clan_members SET mirror_enabled = 0;
    `);
    d.prepare("INSERT INTO meta (key, value) VALUES ('chain_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(chainId));
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  console.log(`[db] chain ${was} -> ${chainId}: trading state reset; members, cults and chats kept; Auto-follow off`);
  return true;
}
