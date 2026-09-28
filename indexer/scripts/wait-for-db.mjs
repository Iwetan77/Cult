// Runs before `envio start`: wait until the indexer's Postgres accepts queries.
// On a host like Railway the database can still be starting or recovering when
// the indexer boots ("not yet accepting connections", ECONNREFUSED). Envio exits
// straight away on that, and the host's restart budget is gone in seconds.
// Reads the same ENVIO_PG_* settings as Envio, with Envio's local defaults.
import postgres from 'postgres';

const limitMs = Number(process.env.WAIT_FOR_DB_SECONDS || 300) * 1000;
const ssl = process.env.ENVIO_PG_SSL_MODE;
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
      console.error(`[wait-for-db] postgres still unavailable after ${limitMs / 1000}s: ${reason}`);
      process.exit(1);
    }
    console.log(`[wait-for-db] waiting for postgres: ${reason}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
if (Date.now() - started > 1000) console.log('[wait-for-db] postgres is up');
await sql.end({ timeout: 5 });
