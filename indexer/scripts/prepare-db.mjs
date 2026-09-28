// Runs before `envio start`:
//
// 1. Wait until the indexer's Postgres accepts queries. On a host like Railway
//    the database can still be starting or recovering when the indexer boots
//    ("not yet accepting connections", ECONNREFUSED). Envio exits straight away
//    on that, and the host's restart budget is gone in seconds.
// 2. Start over when what gets indexed changes. INDEX_VERSION names the rules
//    (plus the config file in use); when the database was built under other
//    rules, its schema is dropped and Envio re-indexes from the start block.
//    Dropping frees the disk at once. Bump INDEX_VERSION with any change that
//    makes old rows wrong or unwanted.
//
// Reads the same ENVIO_PG_* settings as Envio, with Envio's local defaults.
import postgres from 'postgres';

const INDEX_VERSION = '2026-09-28 members only';

const limitMs = Number(process.env.WAIT_FOR_DB_SECONDS || 300) * 1000;
const ssl = process.env.ENVIO_PG_SSL_MODE;
const schema = (process.env.ENVIO_PG_SCHEMA || process.env.ENVIO_PG_PUBLIC_SCHEMA || 'public').replace(/"/g, '');
const version = `${INDEX_VERSION} / ${process.env.ENVIO_CONFIG || 'config.yaml'}`;
const sql = postgres({
  host: process.env.ENVIO_PG_HOST || 'localhost',
  port: Number(process.env.ENVIO_PG_PORT || 5433),
  user: process.env.ENVIO_PG_USER || 'postgres',
  password: process.env.ENVIO_PG_PASSWORD || process.env.ENVIO_POSTGRES_PASSWORD || 'testing',
  database: process.env.ENVIO_PG_DATABASE || 'envio-dev',
  ssl: ssl && ssl !== 'false' ? ssl : false,
  max: 1,
  connect_timeout: 5,
  onnotice: () => {},
});

const started = Date.now();
for (;;) {
  try {
    await sql`select 1`;
    break;
  } catch (e) {
    const reason = e.code || e.message;
    if (Date.now() - started > limitMs) {
      console.error(`[prepare-db] postgres still unavailable after ${limitMs / 1000}s: ${reason}`);
      process.exit(1);
    }
    console.log(`[prepare-db] waiting for postgres: ${reason}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
if (Date.now() - started > 1000) console.log('[prepare-db] postgres is up');

await sql`CREATE SCHEMA IF NOT EXISTS cult_meta`;
await sql`CREATE TABLE IF NOT EXISTS cult_meta.index_version (id int PRIMARY KEY, version text NOT NULL, set_at timestamptz NOT NULL DEFAULT now())`;
const [row] = await sql`SELECT version FROM cult_meta.index_version WHERE id = 1`;
if (row?.version !== version) {
  console.log(`[prepare-db] indexing rules changed (${row?.version ?? 'none'} -> ${version}): starting over`);
  await sql.begin(async (tx) => {
    await tx.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await tx.unsafe(`CREATE SCHEMA "${schema}"`);
    await tx`INSERT INTO cult_meta.index_version (id, version) VALUES (1, ${version})
             ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, set_at = now()`;
  });
}
await sql.end({ timeout: 5 });

// Hosted, index Cult members only (src/members.ts): everyone's history doesn't
// fit and nobody reads it. INDEX_EVERYONE=true overrides.
if (process.env.NODE_ENV === 'production' && !process.env.CULT_API_URL && process.env.INDEX_EVERYONE !== 'true') {
  console.error('[prepare-db] set CULT_API_URL and INDEXER_API_KEY so only Cult members are indexed (or INDEX_EVERYONE=true)');
  process.exit(1);
}
