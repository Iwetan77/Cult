import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ethers } from 'ethers';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { completeEnrollment, setupStatus, startEnrollment } from '../accounts/client-flow.js';
import { sessionFor } from '../accounts/lifecycle.js';
import { env, numEnv } from '../config/env.js';
import { MirrorError, type MirrorEngine } from '../mirror/engine.js';
import { mirrors, trades } from '../mirror/repo.js';
import { stackOnTrade } from '../mirror/stack.js';
import { clearAudience, setAudience } from '../mirror/audience.js';
import { getContext, getMarket } from '../perpl/context.js';
import { listMonMarkets } from '../nadfun/trading.js';
import { monPriceAusd } from '../prices.js';
import { venue, venueOf } from '../venues/index.js';
import { invalidatePerplReads } from '../venues/perpl.js';
import { AuthError, identify, privyLastSignIn } from '../privy/auth.js';
import { backendSignerStatus, forgetSignerStatus, memberSignerGrant } from '../privy/policy.js';
import { clans, MirrorPolicySchema, type MirrorPolicy, AUTO_FOLLOW_DEFAULTS } from '../store/clans.js';
import { getDb } from '../store/db.js';
import { members } from '../store/members.js';
import { PinError, pins } from '../store/pins.js';
import { ensureGas, gasToppingOn } from '../funding/gas.js';
import { buildChart, shortName, toApiMarket } from './chart.js';
import { heldMarkets } from './holdings.js';
import { UpstreamError } from '../http.js';
import { balancesFor, depositInfo } from './balances.js';
import { createShare, getShare, ShareError } from './shares.js';
import { addSuggestion, clanBus, type TpSlSuggestion } from './suggestions.js';
import { ChatError, cultRoom, listMessages, MAX_MESSAGE_CHARS, openRoom, postMessage, postSystem, roomsFor, setPin, type ChatMessage } from './chat.js';
import { countryName } from './countries.js';
import { avatarUrl, displayName, usernameProblem } from './names.js';
import { countryBoard, cultBoard, cultsBoard, globalBoard, LeaderboardError, parsePeriod } from './leaderboards.js';
import { home, profile, ProfileError, tradeView } from './profiles.js';
import { listMarkets, marketDetail, MarketError } from './markets.js';
import { isTradeRoute, MEMBER_LIMIT, PUBLIC_LIMIT, take, TRADE_LIMIT, type Limit } from './limits.js';
import { getConnInfo } from '@hono/node-server/conninfo';
import { setTpSl, TpSlError } from '../trading/tpsl.js';
import { LeverageError, OrderFailed } from '../trading/positions.js';
import { indexerStatus } from '../indexer/stats.js';
import { recentConversion } from '../funding/usdc.js';
import { FundsError } from '../funding/margin.js';
import { SwapUnavailable } from '../swap/kuruFlow.js';
import { confirmFunding, FundingUnavailable, prepareUsdcFunding } from '../funding/plan.js';
import { predictionRoutes } from './predictions.js';
import { intentRoutes, withdrawActions, WithdrawError } from './intents.js';
import { predictionsEnabled } from '../polymarket/client.js';
import { intentsEnabled } from '../intents/aurora.js';
import { PushError, enqueuePush, pushPublicKey, subscribePush, unsubscribePush } from '../notifications/push.js';

type Vars = { Variables: { userId: string; wallet: string } };

// Signed-consent challenges for joining a clan and for changing your policy in one.
const joinChallenges = new Map<string, { userId: string; clanId: string; policy: MirrorPolicy; message: string; expires: number; kind: 'join' | 'policy' }>();

function consentMessage(cultName: string, inviteCode: string, wallet: string, p: MirrorPolicy, nonce: string) {
  return [
    `Join the Cult "${cultName}" (${inviteCode})`,
    `Wallet: ${wallet}`,
    ``,
    p.enabled
      ? `When a member of this cult trades on Perpl or Nad.fun, copy it into my account automatically, and follow their adds, partial sells and exits.`
      : `Do not copy trades into my account.`,
    `Per copy: at most ${p.balancePercentCap}% of my free balance on that venue, and at most $${p.maxUsdPerTrade}.`,
    `I can skip any copy or add before it fires; partial sells and exits follow right away.`,
    `The backend can never withdraw my funds.`,
    ``,
    `Nonce: ${nonce}`,
  ].join('\n');
}

export function createApp(engine: MirrorEngine) {
  engine.setMaxListeners(0); // each open clan SSE stream listens; many is normal
  const app = new Hono<Vars>();
  app.use('*', cors({ origin: env.corsOrigins, allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'DELETE'], exposeHeaders: ['Retry-After'] }));

  // One line per request: method, path, status, time, and who (the member's DID tail).
  if (process.env.LOG_REQUESTS !== '0') {
    app.use('*', async (c, next) => {
      const t0 = Date.now();
      await next();
      if (c.req.path === '/v1/health') return;
      const who = (c.get('userId') as string | undefined)?.slice(-8) ?? '-';
      console.log(`[api] ${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - t0}ms ${who}`);
    });
  }

  const limited = (c: Context<Vars>, key: string, limit: Limit) => {
    const r = take(key, limit);
    if (r.ok) return;
    const secs = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
    c.header('Retry-After', String(secs));
    throw new HTTPException(429, { message: `too many requests, retry in ${secs}s` });
  };
  // Public routes: per IP (the first X-Forwarded-For hop when behind a proxy).
  app.use('/v1/*', async (c, next) => {
    if (c.req.path !== '/v1/health' && !c.req.header('Authorization') && !c.req.path.startsWith('/v1/indexer/') && !c.req.path.startsWith('/v1/avatars/')) {
      const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || remoteAddress(c) || 'unknown';
      limited(c, `ip:${ip}`, PUBLIC_LIMIT);
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ message: err.message }, err.status);
    if (err instanceof AuthError) return c.json({ message: err.message }, 401);
    if (err instanceof PinError) return c.json({ message: err.message, code: err.code }, err.status);
    // A transaction the member's wallet couldn't pay the fee for (no MON).
    if (ethers.isError(err, 'INSUFFICIENT_FUNDS') || /insufficient (balance|funds)/i.test(String((err as Error)?.message ?? ''))) return c.json({ message: NO_GAS, code: 'needs_gas' }, 409);
    if (err instanceof MirrorError) return c.json({ message: err.message }, err.status as 400);
    if (err instanceof ShareError) return c.json({ message: err.message }, err.status);
    if (err instanceof ChatError) return c.json({ message: err.message }, err.status);
    if (err instanceof PushError) return c.json({ message: err.message }, err.status);
    if (err instanceof LeaderboardError) return c.json({ message: err.message }, err.status);
    if (err instanceof ProfileError) return c.json({ message: err.message }, err.status);
    if (err instanceof MarketError) return c.json({ message: err.message }, err.status);
    if (err instanceof TpSlError) return c.json({ message: err.message }, 400);
    if (err instanceof FundsError) return c.json({ message: err.message }, 409);
    if (err instanceof LeverageError) return c.json({ message: err.message, code: 'unsupported_leverage' }, 400);
    if (err instanceof OrderFailed) {
      console.warn('[api] Perpl order not completed:', err.message);
      return c.json({ message: `Perpl could not complete this order (status ${err.order.st}, reason ${err.order.sr}, fill reason ${err.order.fr ?? '-'}). Refresh your positions before placing another trade.`, code: 'order_failed' }, 502);
    }
    if (err instanceof WithdrawError) return c.json({ message: err.message }, err.status);
    if (err instanceof SwapUnavailable) return c.json({ message: `Couldn't swap for this trade right now (${err.message}). Try again shortly.` }, 503);
    if (err instanceof z.ZodError) return c.json({ message: 'invalid request', issues: err.issues }, 400);
    // Upstream (Perpl / Nad.fun / Kuru / RPC) unreachable: say so, let the client retry.
    if (err instanceof UpstreamError || (err instanceof TypeError && /fetch failed/.test(err.message)) || (err as { name?: string })?.name === 'TimeoutError') {
      console.warn('[api] upstream unavailable:', err.message);
      return c.json({ message: 'a trading service is unreachable right now, retry shortly' }, 503);
    }
    console.error('[api]', err);
    return c.json({ message: 'internal error' }, 500);
  });

  const bad = (status: 400 | 403 | 404 | 409, message: string) => new HTTPException(status, { message });

  // ---- public ---------------------------------------------------------------

  app.get('/v1/health', (c) => c.json({ ok: true }));

  // Is the verified-records indexer connected and caught up, and is our own
  // database on a disk that survives deploys? Public, no member data.
  app.get('/v1/status', async (c) => c.json({ indexer: await indexerStatus(), storage: storageStatus() }));

  // Is a username free? Public: the sign-up screen checks as you type, and it
  // reveals nothing a profile page doesn't. (Setting it is signed-in only.)
  app.get('/v1/usernames/:name', (c) => {
    const name = c.req.param('name');
    const problem = usernameProblem(name);
    if (problem) return c.json({ available: false, reason: problem });
    return c.json(members.byUsername(name) ? { available: false, reason: 'taken' } : { available: true });
  });

  // Profile photos, public (they show next to names in chats and leaderboards).
  // URLs carry ?v=<last change>, so they can be cached for a long time.
  app.get('/v1/avatars/:userId', (c) => {
    const a = members.avatar(c.req.param('userId'));
    if (!a) return c.json({ message: 'no photo' }, 404);
    return c.body(new Uint8Array(a.bytes), 200, { 'Content-Type': a.mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
  });

  app.get('/v1/config', async (c) => {
    const ctx = await getContext();
    return c.json({
      chainId: env.chainId,
      venues: ['perpl', 'nadfun'],
      displayUnit: 'USD', // show $ everywhere; the word AUSD only appears on the funding screen
      monPriceAusd: await monPriceAusd().catch(() => null),
      autoMirrorOptOutWindowSeconds: env.mirrorOptOutSeconds,
      autoFollowDefaults: AUTO_FOLLOW_DEFAULTS, // what the Auto-follow switch suggests
      mirrorPolicyBounds: { balancePercentCap: { min: 0, minExclusive: true, max: 100 }, maxUsdPerTrade: { min: 1, max: 1_000_000 } },
      markets: ctx.markets.filter((m) => m.config.is_open).map(toApiMarket),
      // What's switched on. predictions: Polymarket bets (needs the builder key);
      // crossChain: deposits from / withdrawals to other chains (Aurora Intents, mainnet).
      features: { predictions: predictionsEnabled(), crossChain: intentsEnabled() && env.chainId === 143, gasTopUp: gasToppingOn() },
    });
  });

  // Public share card. No auth, no clan identity unless opted in.
  app.get('/v1/shares/:id', (c) => {
    const share = getShare(c.req.param('id'));
    if (!share) throw bad(404, 'share not found');
    return c.json(share);
  });

  // Nad.fun tokens Cult can trade (MON-quoted only), for the market picker.
  // Every market on both venues, searchable: ?q= (symbol, name, or a token
  // address), ?venue=perpl|nadfun, ?limit=. Public, like any price list.
  app.get('/v1/markets', async (c) => {
    const venue = z.enum(['perpl', 'nadfun']).optional().catch(undefined).parse(c.req.query('venue'));
    const limit = Number(c.req.query('limit') ?? 50) || 50;
    return c.json({ markets: await listMarkets({ q: c.req.query('q') ?? undefined, venue, limit }) });
  });
  // One market: listing + candles (?resolution= seconds: 60, 300, 900, 3600, 14400, 86400).
  app.get('/v1/markets/:id', async (c) => {
    const resolution = z.coerce.number().int().catch(300).parse(c.req.query('resolution') ?? 300);
    return c.json(await marketDetail(c.req.param('id'), [60, 300, 900, 1800, 3600, 14400, 86400].includes(resolution) ? resolution : 300));
  });

  app.get('/v1/nadfun/markets', async (c) => {
    const order = z.enum(['latest_trade', 'market_cap', 'creation_time']).catch('latest_trade').parse(c.req.query('order'));
    const monPx = await monPriceAusd();
    const list = await listMonMarkets(order, 100);
    return c.json({
      markets: list.map((m) => ({
        venue: 'nadfun',
        id: m.token.toLowerCase(),
        symbol: m.symbol,
        baseSymbol: m.symbol,
        quoteSymbol: 'USD',
        name: m.name,
        tokenAddress: m.token.toLowerCase(),
        imageUri: m.imageUri ?? null,
        graduated: m.graduated,
        priceAusd: m.priceMon * monPx,
        maxLeverage: 1,
        makerFeeBps: null,
        takerFeeBps: null,
      })),
    });
  });

  // ---- indexer (shared secret, server-to-server) ---------------------------

  const indexer = new Hono();
  indexer.use('*', async (c, next) => {
    if (!env.indexerApiKey || c.req.header('X-Indexer-Key') !== env.indexerApiKey) throw bad(403, 'bad indexer key');
    await next();
  });
  indexer.get('/accounts', (c) => {
    const rows = getDb()
      .prepare(
        `SELECT m.user_id, m.wallet, m.perpl_account_id, GROUP_CONCAT(cm.clan_id) AS clan_ids
         FROM members m LEFT JOIN clan_members cm ON cm.user_id = m.user_id
         GROUP BY m.user_id`,
      )
      .all() as { user_id: string; wallet: string; perpl_account_id: number; clan_ids: string | null }[];
    return c.json({
      accounts: rows.map((r) => ({ userId: r.user_id, wallet: r.wallet, perplAccountId: r.perpl_account_id, clanIds: r.clan_ids?.split(',') ?? [] })),
    });
  });
  indexer.get('/orders', (c) => {
    const since = Number(c.req.query('since') ?? 0);
    const rows = getDb()
      .prepare(
        `SELECT e.account_id, e.rq, e.kind, e.ref_id, e.created_at,
                mi.id AS mirror_id,
                COALESCE(mi.clan_id, st.clan_id) AS clan_id,
                COALESCE(mi.trade_id, st.target_trade) AS trade_id
         FROM engine_orders e
         LEFT JOIN mirror_adjustments ad ON e.kind IN ('mirror_add', 'mirror_reduce') AND ad.id = e.ref_id
         LEFT JOIN mirrors mi ON e.kind LIKE 'mirror%' AND mi.id = COALESCE(ad.mirror_id, e.ref_id)
         LEFT JOIN stacks st ON e.kind LIKE 'stack%' AND st.id = e.ref_id
         WHERE e.created_at > ? ORDER BY e.created_at LIMIT 1000`,
      )
      .all(since) as { account_id: number; rq: number; kind: string; ref_id: string; mirror_id: string | null; created_at: number; clan_id: string; trade_id: string }[];
    return c.json({
      orders: rows.map((r) => ({
        perplAccountId: r.account_id,
        requestId: r.rq,
        kind: r.kind,
        refId: r.ref_id,
        mirrorId: r.mirror_id,
        clanId: r.clan_id,
        tradeId: r.trade_id,
        createdAt: r.created_at,
      })),
    });
  });
  // Nad.fun txs the engine sent (mirrors/stacks). Anything else by a member is their own trade.
  indexer.get('/txs', (c) => {
    const since = Number(c.req.query('since') ?? 0);
    const rows = getDb()
      .prepare(
        `SELECT e.tx_hash, e.wallet, e.kind, e.ref_id, e.created_at,
                mi.id AS mirror_id,
                COALESCE(mi.clan_id, st.clan_id) AS clan_id,
                COALESCE(mi.trade_id, st.target_trade) AS trade_id
         FROM engine_txs e
         LEFT JOIN mirror_adjustments ad ON e.kind IN ('mirror_add', 'mirror_reduce') AND ad.id = e.ref_id
         LEFT JOIN mirrors mi ON e.kind LIKE 'mirror%' AND mi.id = COALESCE(ad.mirror_id, e.ref_id)
         LEFT JOIN stacks st ON e.kind LIKE 'stack%' AND st.id = e.ref_id
         WHERE e.created_at > ? ORDER BY e.created_at LIMIT 1000`,
      )
      .all(since) as { tx_hash: string; wallet: string; kind: string; ref_id: string; mirror_id: string | null; created_at: number; clan_id: string; trade_id: string }[];
    return c.json({
      txs: rows.map((r) => ({ venue: 'nadfun', txHash: r.tx_hash, wallet: r.wallet, kind: r.kind, refId: r.ref_id, mirrorId: r.mirror_id, clanId: r.clan_id, tradeId: r.trade_id, createdAt: r.created_at })),
    });
  });
  indexer.get('/trades', (c) => {
    const since = Number(c.req.query('since') ?? 0);
    const rows = getDb().prepare('SELECT * FROM leader_trades WHERE opened_at > ? ORDER BY opened_at LIMIT 1000').all(since) as Record<string, unknown>[];
    return c.json({
      trades: rows.map((r) => ({
        tradeId: r.id,
        venue: r.venue,
        userId: r.user_id,
        perplAccountId: r.account_id,
        market: r.market,
        side: r.side,
        positionId: r.position_id,
        openTx: r.open_tx,
        openedAt: r.opened_at,
        closedAt: r.closed_at,
      })),
    });
  });
  app.route('/v1/indexer', indexer);

  // ---- authenticated -------------------------------------------------------

  const authed = new Hono<Vars>();
  authed.use('*', async (c, next) => {
    const id = await identify(c.req.header('Authorization'));
    if (!id.wallet) throw bad(409, 'Your wallet is still being created. Try again in a moment.');
    const isNew = !members.get(id.userId);
    members.upsert(id.userId, id.wallet, id.walletId);
    if (isNew) postSystem('global', id.userId, 'joined Cult');
    c.set('userId', id.userId);
    c.set('wallet', id.wallet.toLowerCase());
    limited(c, `member:${id.userId}`, MEMBER_LIMIT);
    if (isTradeRoute(c.req.method, c.req.path)) limited(c, `trade:${id.userId}`, TRADE_LIMIT);
    await next();
  });

  const clanFor = (c: Context<Vars>) => {
    const clan = clans.get(c.req.param('clanId')!);
    if (!clan || !clans.membership(clan.id, c.get('userId'))) throw bad(404, 'cult not found');
    return clan;
  };
  authed.get('/notifications/push', (c) => c.json({ publicKey: pushPublicKey() }));
  authed.post('/notifications/push', async (c) => {
    const subscription = z.object({ endpoint: z.string().max(4096), keys: z.object({ p256dh: z.string().max(128), auth: z.string().max(64) }) }).parse(await c.req.json());
    subscribePush(c.get('userId'), subscription);
    return c.body(null, 204);
  });
  authed.delete('/notifications/push', async (c) => {
    const { endpoint } = z.object({ endpoint: z.string().max(4096) }).parse(await c.req.json());
    unsubscribePush(c.get('userId'), endpoint);
    return c.body(null, 204);
  });
  authed.post('/notifications/push/test', (c) => {
    limited(c, `push-test:${c.get('userId')}`, { max: 1, windowMs: 60_000 });
    const subscribed = getDb().prepare('SELECT id FROM push_subscriptions WHERE user_id = ? LIMIT 1').get(c.get('userId'));
    if (!subscribed) throw bad(409, 'enable phone alerts on this device first');
    const id = `test:${randomUUID()}`;
    enqueuePush(id, [{ userId: c.get('userId') }], { title: 'Cult phone alerts are on', body: 'You can receive liquidation and new cult trade alerts.', url: '/settings', tag: id });
    return c.body(null, 204);
  });
  const clanView = (clanId: string, userId: string) => {
    const clan = clans.get(clanId)!;
    return {
      id: clan.id,
      name: clan.name,
      inviteCode: clan.inviteCode,
      visibility: clan.visibility,
      isOwner: clan.createdBy === userId,
      isAdmin: clans.isAdmin(clan.id, userId), // admins share trades here
      memberCount: clans.members(clan.id).length,
      myPolicy: clans.membership(clan.id, userId)?.policy ?? null,
      autoFollow: clans.membership(clan.id, userId)?.policy.enabled ?? false,
    };
  };

  authed.get('/me', async (c) => {
    const userId = c.get('userId');
    const m = members.get(userId)!;
    return c.json({
      id: userId,
      address: m.wallet,
      name: displayName(m),
      username: m.username,
      needsUsername: !m.username, // first sign-in: ask for one before anything else
      pinSet: pins.isSet(m.userId), // then a 4-digit PIN (store/pins.ts)
      avatarUrl: avatarUrl(m),
      country: m.country ? { code: m.country, name: countryName(m.country) } : null,
      rooms: roomsFor(userId),
      clans: clans.forUser(userId).map((cl) => clanView(cl.id, userId)),
      perpl: { accountId: m.perplAccountId, keyEnrolled: !!m.apiKey, forwarding: m.forwarding },
      balances: await gasCheckedBalances(userId, m.wallet),
      // prepared = grant issued; attached/policyCurrent = verified with Privy.
      signer: await backendSignerStatus(userId).catch(() => ({ prepared: !!m.privyPolicyId, attached: null, policyCurrent: null })),
      usdcConverted: recentConversion(userId), // last USDC -> AUSD conversion, if in the last 10 min
    });
  });

  // The Deposit screen: your address + what you can send + what you hold.
  authed.get('/wallet/deposit', async (c) => c.json(await depositInfo(c.get('userId'))));

  // PIN: set right after the username (/v1/me.pinSet), asked before money
  // leaves Cult. Changing it needs the current one; a forgotten one is reset
  // after signing in again (Privy says the last sign-in was minutes ago).
  authed.post('/me/pin', async (c) => {
    const b = z.object({ pin: z.string(), currentPin: z.string().optional() }).parse(await c.req.json());
    pins.set(c.get('userId'), b.pin, b.currentPin);
    return c.json({ pinSet: true });
  });
  authed.post('/me/pin/reset', async (c) => {
    const b = z.object({ pin: z.string() }).parse(await c.req.json());
    const last = await privyLastSignIn(c.get('userId'));
    if (last == null || Date.now() - last > PIN_RESET_WINDOW_MS) throw bad(403, 'Sign in again to reset your PIN.');
    pins.reset(c.get('userId'), b.pin);
    return c.json({ pinSet: true });
  });

  // Username: asked once at first sign-in (/v1/me.needsUsername), changeable later.
  authed.post('/me/username', async (c) => {
    const { username } = z.object({ username: z.string().trim() }).parse(await c.req.json());
    const problem = usernameProblem(username);
    if (problem) throw bad(400, problem);
    const taken = members.byUsername(username);
    if (taken && taken.userId !== c.get('userId')) throw bad(409, 'that username is taken');
    try {
      members.setUsername(c.get('userId'), username);
    } catch {
      throw bad(409, 'that username is taken'); // lost a race for it
    }
    const m = members.get(c.get('userId'))!;
    return c.json({ username: m.username, name: displayName(m) });
  });

  // Profile photo: { image: "data:image/png;base64,..." }, resized in the
  // browser first (256x256 is plenty). PNG, JPEG or WebP, up to 512 KB.
  authed.post('/me/avatar', async (c) => {
    const { image } = z.object({ image: z.string().max(800_000) }).parse(await c.req.json());
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!m) throw bad(400, 'send a PNG, JPEG or WebP as a data URL');
    const bytes = Buffer.from(m[2]!, 'base64');
    if (bytes.length > 512 * 1024) throw bad(400, 'photo is over 512 KB; resize it first');
    const sniff = bytes.subarray(0, 12);
    const isPng = sniff[0] === 0x89 && sniff[1] === 0x50 && sniff[2] === 0x4e && sniff[3] === 0x47;
    const isJpeg = sniff[0] === 0xff && sniff[1] === 0xd8 && sniff[2] === 0xff;
    const isWebp = sniff.subarray(0, 4).toString('ascii') === 'RIFF' && sniff.subarray(8, 12).toString('ascii') === 'WEBP';
    const mime = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : isWebp ? 'image/webp' : null;
    if (!mime || mime !== m[1]) throw bad(400, "that file isn't the image type it says it is");
    members.setAvatar(c.get('userId'), mime, bytes);
    return c.json({ avatarUrl: avatarUrl(members.get(c.get('userId'))) });
  });
  authed.delete('/me/avatar', (c) => {
    members.clearAvatar(c.get('userId'));
    return c.body(null, 204);
  });

  // Your country: puts you in its chat room and its leaderboard (like picking
  // your country when you join a fantasy league). Change it any time.
  authed.post('/me/country', async (c) => {
    const body = z.object({ country: z.string().length(2) }).parse(await c.req.json());
    const code = body.country.toUpperCase();
    const name = countryName(code);
    if (!name) throw bad(400, `${body.country} isn't a country code (ISO 3166, e.g. NG, GB, US)`);
    const before = members.get(c.get('userId'))?.country;
    members.setCountry(c.get('userId'), code);
    if (before !== code) postSystem(`country:${code}`, c.get('userId'), 'joined');
    return c.json({ country: { code, name }, rooms: roomsFor(c.get('userId')) });
  });

  // ---- home feed and profiles (the Home and Account screens) ----
  authed.get('/home', async (c) => c.json(await home(c.get('userId'))));
  authed.get('/members/:id', async (c) => c.json(await profile(c.req.param('id'), c.get('userId'))));
  authed.get('/trades/:id', async (c) => c.json(await tradeView(c.req.param('id'), c.get('userId'))));

  // ---- leaderboards: global, a country, public cults ------------------------
  const boardLimit = (c: Context<Vars>) => Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 500);
  authed.get('/leaderboards/global', async (c) => c.json(await globalBoard(c.get('userId'), boardLimit(c), parsePeriod(c.req.query('period')))));
  authed.get('/leaderboards/country/:code?', async (c) => {
    const code = c.req.param('code') ?? members.get(c.get('userId'))?.country;
    if (!code) throw bad(409, 'pick your country first (POST /v1/me/country)');
    return c.json(await countryBoard(code, c.get('userId'), boardLimit(c), parsePeriod(c.req.query('period'))));
  });
  authed.get('/leaderboards/cults', async (c) => c.json(await cultsBoard(c.get('userId'), Math.min(boardLimit(c), 100))));

  // ---- chat rooms: global, your country, your cults ------------------------
  authed.get('/chat/rooms', (c) => c.json({ rooms: roomsFor(c.get('userId')) }));
  authed.get('/chat/:room/messages', (c) => {
    const { room } = openRoom(c.req.param('room'), c.get('userId'));
    const limit = c.req.query('limit');
    return c.json(listMessages(room, { before: c.req.query('before') || undefined, limit: limit ? Number(limit) : undefined }));
  });
  authed.post('/chat/:room/messages', async (c) => {
    const { room } = openRoom(c.req.param('room'), c.get('userId'));
    const body = z
      .object({ body: z.string().max(MAX_MESSAGE_CHARS * 2), replyTo: z.string().max(64).nullish(), markerId: z.string().max(128).nullish() })
      .parse(await c.req.json());
    // A shared cult ("cult:<id>") must be a public cult the sender is in. Trade
    // links only go in cult rooms: Global and country rooms are for finding
    // cults, not for following strangers' trades.
    if (body.markerId?.startsWith('cult:')) {
      const shared = clans.get(body.markerId.slice(5));
      if (!shared || shared.visibility !== 'public' || !clans.membership(shared.id, c.get('userId'))) throw bad(400, 'only a public cult you are in can be shared');
    } else if (body.markerId && !room.startsWith('cult:')) throw bad(400, 'trades are shared in cults');
    return c.json(postMessage(room, c.get('userId'), body), 201);
  });
  // The cult owner pins a message ({ messageId }) or clears it ({ messageId: null }).
  authed.post('/chat/:room/pin', async (c) => {
    const { room } = openRoom(c.req.param('room'), c.get('userId'));
    const body = z.object({ messageId: z.string().max(64).nullable() }).parse(await c.req.json());
    return c.json({ pinned: setPin(room, c.get('userId'), body.messageId) });
  });

  // Live messages for one room (the cult stream carries its cult room too).
  authed.get('/chat/:room/events', (c) => {
    const { room } = openRoom(c.req.param('room'), c.get('userId'));
    return streamSSE(c, async (stream) => {
      const onMessage = (r: string, msg: ChatMessage) => r === room && void stream.writeSSE({ event: 'message', data: JSON.stringify(msg) });
      clanBus.on('message', onMessage);
      const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: String(Date.now()) }), 15_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      clanBus.off('message', onMessage);
    });
  });

  // What the frontend passes to Privy's useSigners().addSigners() so the
  // backend can act on this wallet, only within the policy.
  // Every member's trades, top-ups and USDC conversions are signed by the
  // backend under this policy, so everyone gets it, not only Auto-follow users.
  // The per-transaction cap is TRADING_CAP_USD, or a higher Auto-follow limit.
  authed.get('/privy/signer', async (c) => {
    const userId = c.get('userId');
    const caps = clans
      .forUser(userId)
      .map((cl) => clans.membership(cl.id, userId)!.policy)
      .filter((p) => p.enabled)
      .map((p) => p.maxUsdPerTrade);
    const grant = await memberSignerGrant(userId, c.get('wallet'), Math.max(numEnv('TRADING_CAP_USD', 1000), ...caps));
    forgetSignerStatus(userId); // the frontend is about to (re)attach it; re-check on next read
    return c.json(grant);
  });

  // Perpl account setup, driven by the member's own wallet in the browser.
  authed.get('/perpl/setup', async (c) => {
    const deposit = c.req.query('depositRaw');
    return c.json(await setupStatus(c.get('userId'), deposit ? BigInt(deposit) : undefined));
  });
  authed.post('/enrollment/perpl/challenge', async (c) => c.json(await startEnrollment(c.get('userId'))));
  authed.post('/enrollment/perpl', async (c) => {
    const body = z.object({ challengeId: z.string(), signature: z.string() }).parse(await c.req.json());
    await completeEnrollment(c.get('userId'), body.challengeId, body.signature);
    await engine.watch(c.get('userId')).catch(() => undefined);
    return c.body(null, 204);
  });

  // Everything the member holds, both venues, valued in AUSD right now.
  authed.get('/positions', async (c) => {
    const userId = c.get('userId');
    const [p, n] = await Promise.all([
      venue('perpl').holdings(userId).catch(() => []),
      venue('nadfun').holdings(userId, heldMarkets(userId, 'nadfun')).catch(() => []),
    ]);
    return c.json({ positions: [...p, ...n] });
  });

  // A member's own trade, on either venue. Not tagged as an engine order, so
  // it's a leader trade and clan-mates get auto-mirrored. marketId is a Perpl
  // market id or a Nad.fun token address; notional = marginUsd x leverage (AUSD).
  authed.post('/positions/open', async (c) => {
    const body = z
      .object({
        marketId: z.coerce.string(),
        side: z.enum(['long', 'short', 'buy']),
        marginUsd: z.number().positive(),
        leverage: z.number().min(1).default(1),
        // "Post to": which of your cults see and copy this trade. Omitted = all
        // of them; [] = just you (no notices, no copies).
        cultIds: z.array(z.string()).max(50).optional(),
      })
      .parse(await c.req.json());
    const userId = c.get('userId');
    const m = members.get(userId)!;
    const v = venueOf(body.marketId);
    if (body.cultIds) {
      const mine = new Set(clans.forUser(userId).map((cl) => cl.id));
      const notMine = body.cultIds.find((id) => !mine.has(id));
      if (notMine) throw bad(400, `you're not in cult ${notMine}`);
    }
    if (v === 'perpl') {
      if (!m.perplAccountId || !m.forwarding) throw bad(409, 'finish Perpl setup first');
      if (body.side === 'buy') throw bad(400, 'perpl side must be long or short');
      await getMarket(Number(body.marketId));
    } else if (body.side !== 'buy') throw bad(400, 'nad.fun side must be buy');
    if (body.cultIds) setAudience(userId, v, body.marketId, body.cultIds);
    try {
      const fill = await venue(v).open({ userId, market: body.marketId, side: body.side, notionalAusd: body.marginUsd * body.leverage, leverage: body.leverage });
      return c.json(fill);
    } catch (error) {
      clearAudience(userId, v, body.marketId);
      throw error;
    }
  });

  // TP/SL on your own Perpl position, as real Perpl trigger orders. A number
  // sets that leg, null removes it, omitted keeps it. Prices in $.
  authed.post('/positions/tpsl', async (c) => {
    const leg = z.number().positive().nullable().optional();
    const body = z.object({ marketId: z.coerce.string(), takeProfit: leg, stopLoss: leg }).parse(await c.req.json());
    if (venueOf(body.marketId) !== 'perpl') throw bad(400, 'TP/SL is Perpl only; Nad.fun is spot');
    const userId = c.get('userId');
    const m = members.get(userId)!;
    if (!m.perplAccountId) throw bad(409, 'no Perpl account');
    const out = await setTpSl(await sessionFor(userId), m.perplAccountId, Number(body.marketId), { takeProfit: body.takeProfit, stopLoss: body.stopLoss });
    invalidatePerplReads(userId);
    return c.json(out);
  });

  authed.post('/positions/close', async (c) => {
    const body = z.object({ marketId: z.coerce.string(), sizeRaw: z.string().regex(/^\d+$/).optional() }).parse(await c.req.json());
    const userId = c.get('userId');
    const v = venueOf(body.marketId);
    if (v === 'perpl' && !members.get(userId)?.perplAccountId) throw bad(409, 'no Perpl account');
    return c.json(await venue(v).close({ userId, market: body.marketId, sizeRaw: body.sizeRaw }));
  });

  // "Pay with USDC": ordered wallet actions (Kuru swap -> Perpl deposit) for
  // the member to sign. 409 with a plain reason where it can't work (testnet,
  // empty book). amountUsdc is a decimal string, e.g. "25.5".
  authed.post('/funding/usdc/prepare', async (c) => {
    const body = z.object({ amountUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/), depositToPerpl: z.boolean().default(true) }).parse(await c.req.json());
    try {
      return c.json(await prepareUsdcFunding(c.get('wallet'), ethers.parseUnits(body.amountUsdc, 6), body.depositToPerpl));
    } catch (e) {
      if (e instanceof FundingUnavailable) throw bad(409, e.message);
      throw e;
    }
  });
  authed.post('/funding/usdc/confirm', async (c) => {
    const body = z.object({ planId: z.string(), hashes: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)) }).parse(await c.req.json());
    return c.json(await confirmFunding(c.get('wallet'), body.planId, body.hashes));
  });

  // ---- cults (the product's name for clans) --------------------------------
  // One set of routes, served under /v1/cults and the older /v1/clans.
  const cultRoutes = new Hono<Vars>();

  cultRoutes.post('/', async (c) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(48), policy: MirrorPolicySchema.optional(), visibility: z.enum(['private', 'public']).default('private') })
      .parse(await c.req.json());
    const clan = clans.create(body.name, c.get('userId'), body.policy, body.visibility);
    postSystem(cultRoom(clan.id), c.get('userId'), 'created the cult');
    await engine.watch(c.get('userId')).catch(() => undefined);
    return c.json(clanView(clan.id, c.get('userId')), 201);
  });

  // Which cult a join is for: a code (any cult), or the id of a public one.
  const joinable = (b: { inviteCode?: string; cultId?: string }, userId: string) => {
    const clan = b.inviteCode ? clans.byInvite(b.inviteCode) : clans.get(b.cultId!);
    if (!clan) throw bad(404, b.inviteCode ? 'no cult with that code' : 'cult not found');
    if (!b.inviteCode && clan.visibility !== 'public') throw bad(404, 'cult not found'); // private: code only
    if (clans.membership(clan.id, userId)) throw bad(409, "you're already in this cult");
    return clan;
  };
  const target = z
    .object({ inviteCode: z.string().optional(), cultId: z.string().optional() })
    .refine((b) => !!b.inviteCode !== !!b.cultId, 'send an inviteCode, or the cultId of a public cult');

  // Join with Auto-follow already on (signed limits), in one step.
  cultRoutes.post('/join/challenge', async (c) => {
    const body = target.and(z.object({ policy: MirrorPolicySchema })).parse(await c.req.json());
    const clan = joinable(body, c.get('userId'));
    const challengeId = randomUUID();
    const message = consentMessage(clan.name, clan.inviteCode, ethers.getAddress(c.get('wallet')), body.policy, challengeId);
    joinChallenges.set(challengeId, { userId: c.get('userId'), clanId: clan.id, policy: body.policy, message, expires: Date.now() + 10 * 60_000, kind: 'join' });
    return c.json({ challengeId, message });
  });

  // Join: { inviteCode } or { cultId } joins the group with copying off (no
  // signature: nothing touches funds). { challengeId, signature } completes a
  // join-with-Auto-follow started at /join/challenge.
  cultRoutes.post('/join', async (c) => {
    const raw = await c.req.json();
    if (!('challengeId' in raw)) {
      const clan = joinable(target.parse(raw), c.get('userId'));
      clans.join(clan.id, c.get('userId'));
      postSystem(cultRoom(clan.id), c.get('userId'), 'joined the cult');
      await engine.watch(c.get('userId')).catch(() => undefined);
      return c.json(clanView(clan.id, c.get('userId')));
    }
    const body = z.object({ challengeId: z.string(), signature: z.string() }).parse(raw);
    const ch = joinChallenges.get(body.challengeId);
    if (!ch || ch.kind !== 'join' || ch.userId !== c.get('userId') || Date.now() > ch.expires) throw bad(400, 'challenge missing or expired');
    const signer = ethers.verifyMessage(ch.message, body.signature);
    if (signer.toLowerCase() !== c.get('wallet')) throw bad(403, 'signature is not from your wallet');
    clans.join(ch.clanId, ch.userId, ch.policy);
    postSystem(cultRoom(ch.clanId), ch.userId, ch.policy.enabled ? 'joined the cult with Auto-follow on' : 'joined the cult');
    getDb()
      .prepare('INSERT OR REPLACE INTO join_consents (clan_id, user_id, message, signature, signed_at) VALUES (?, ?, ?, ?, ?)')
      .run(ch.clanId, ch.userId, ch.message, body.signature, Date.now());
    joinChallenges.delete(body.challengeId);
    await engine.watch(ch.userId).catch(() => undefined);
    return c.json(clanView(ch.clanId, ch.userId));
  });

  // Change your mirror policy in a clan. Same consent as joining: sign the new
  // terms. Raising maxUsdPerTrade also needs a fresh Privy grant: call
  // GET /v1/privy/signer and addSigners() again with the returned policyIds.
  cultRoutes.post('/:clanId/policy/challenge', async (c) => {
    const clan = clanFor(c);
    const body = z.object({ policy: MirrorPolicySchema }).parse(await c.req.json());
    const challengeId = randomUUID();
    const wasOn = clans.membership(clan.id, c.get('userId'))?.policy.enabled ?? false;
    const lead = body.policy.enabled && !wasOn ? 'Turn on Auto-follow in the Cult' : 'Update my copy limits in the Cult';
    const message = consentMessage(clan.name, clan.inviteCode, ethers.getAddress(c.get('wallet')), body.policy, challengeId).replace(/^Join the Cult/, lead);
    joinChallenges.set(challengeId, { userId: c.get('userId'), clanId: clan.id, policy: body.policy, message, expires: Date.now() + 10 * 60_000, kind: 'policy' });
    return c.json({ challengeId, message });
  });

  cultRoutes.post('/:clanId/policy', async (c) => {
    const clan = clanFor(c);
    const body = z.object({ challengeId: z.string(), signature: z.string() }).parse(await c.req.json());
    const ch = joinChallenges.get(body.challengeId);
    if (!ch || ch.kind !== 'policy' || ch.clanId !== clan.id || ch.userId !== c.get('userId') || Date.now() > ch.expires) throw bad(400, 'challenge missing or expired');
    if (ethers.verifyMessage(ch.message, body.signature).toLowerCase() !== c.get('wallet')) throw bad(403, 'signature is not from your wallet');
    const wasOn = clans.membership(clan.id, ch.userId)?.policy.enabled ?? false;
    clans.setPolicy(clan.id, ch.userId, ch.policy);
    if (ch.policy.enabled && !wasOn) postSystem(cultRoom(clan.id), ch.userId, 'turned on Auto-follow');
    getDb()
      .prepare('INSERT OR REPLACE INTO join_consents (clan_id, user_id, message, signature, signed_at) VALUES (?, ?, ?, ?, ?)')
      .run(clan.id, ch.userId, ch.message, body.signature, Date.now());
    joinChallenges.delete(body.challengeId);
    return c.json(clanView(clan.id, ch.userId));
  });

  // Auto-follow off: stops copying new trades straight away, no signature (it
  // only reduces what the backend may do). Copies already open still follow
  // their leader's partial sells and exit. Turning it on is the signed
  // /policy/challenge + /policy with enabled: true.
  cultRoutes.post('/:clanId/auto-follow', async (c) => {
    const clan = clanFor(c);
    const body = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    if (body.enabled) throw bad(400, 'turning Auto-follow on needs your signed limits: POST /policy/challenge with enabled: true, then /policy');
    const m = clans.membership(clan.id, c.get('userId'))!;
    clans.setPolicy(clan.id, c.get('userId'), { ...m.policy, enabled: false });
    engine.memberLeft(clan.id, c.get('userId')); // cancels anything still pending for them here
    return c.json(clanView(clan.id, c.get('userId')));
  });

  // Public cults anyone can join. Private ones never show here.
  cultRoutes.get('/discover', async (c) => {
    const userId = c.get('userId');
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 100);
    const list = clans.publicList(500).map((cl) => ({
      id: cl.id,
      name: cl.name,
      visibility: cl.visibility,
      memberCount: clans.members(cl.id).length,
      createdAt: cl.createdAt,
      joined: !!clans.membership(cl.id, userId),
    }));
    list.sort((a, b) => b.memberCount - a.memberCount || b.createdAt - a.createdAt);
    return c.json({ cults: list.slice(0, limit) });
  });

  // A cult's own leaderboard: its members, or anyone for a public cult.
  cultRoutes.get('/:clanId/leaderboard', async (c) => {
    const clan = clans.get(c.req.param('clanId'));
    if (!clan || (clan.visibility !== 'public' && !clans.membership(clan.id, c.get('userId')))) throw bad(404, 'cult not found');
    return c.json(await cultBoard(clan, c.get('userId'), boardLimit(c), parsePeriod(c.req.query('period'))));
  });

  // Admins make another member an admin (they then share trades with the cult
  // too) or take it back. The creator always stays one.
  cultRoutes.post('/:clanId/admins', async (c) => {
    const clan = clanFor(c);
    const { memberId, admin } = z.object({ memberId: z.string().min(1).max(200), admin: z.boolean() }).parse(await c.req.json());
    if (!clans.isAdmin(clan.id, c.get('userId'))) throw bad(403, 'only admins can change admins');
    if (!clans.membership(clan.id, memberId)) throw bad(404, 'not a member of this cult');
    if (memberId === clan.createdBy && !admin) throw bad(400, 'The cult owner cannot be demoted.');
    if (clans.isAdmin(clan.id, memberId) !== admin) {
      clans.setRole(clan.id, memberId, admin ? 'admin' : 'member');
      const who = members.get(memberId);
      postSystem(cultRoom(clan.id), c.get('userId'), `${admin ? 'made' : 'removed'} ${who ? displayName(who) : 'a member'} ${admin ? 'an admin' : 'as admin'}`);
    }
    return c.json({ memberId, admin: clans.isAdmin(clan.id, memberId), owner: memberId === clan.createdBy });
  });

  // The owner makes their cult public (listed, joinable without the code) or private again.
  cultRoutes.post('/:clanId/visibility', async (c) => {
    const clan = clanFor(c);
    if (clan.createdBy !== c.get('userId')) throw bad(403, 'only the cult owner can change this');
    const body = z.object({ visibility: z.enum(['private', 'public']) }).parse(await c.req.json());
    clans.setVisibility(clan.id, body.visibility);
    return c.json(clanView(clan.id, c.get('userId')));
  });

  // Leave a clan. Pending mirrors and pending adds for you are cancelled;
  // mirrors already open still follow partial exits and unwind when their
  // leader exits, so nothing is left orphaned.
  cultRoutes.post('/:clanId/leave', async (c) => {
    const clan = clanFor(c);
    const userId = c.get('userId');
    engine.memberLeft(clan.id, userId);
    clans.leave(clan.id, userId);
    postSystem(cultRoom(clan.id), userId, 'left the cult');
    return c.body(null, 204);
  });

  cultRoutes.get('/:clanId/chart', async (c) => {
    const clan = clanFor(c);
    const marketId = c.req.query('marketId');
    const resolution = Number(c.req.query('resolution') ?? 300);
    return c.json(await buildChart(clan, c.get('userId'), marketId || undefined, resolution));
  });

  cultRoutes.post('/:clanId/mirrors/:mirrorId/skip', async (c) => {
    clanFor(c);
    // Accept the bare mirror id, the chart marker id ("mirror:<id>"), or a
    // pending add to a mirror ("adjust:<id>", from marker.pendingAdd.id).
    const id = c.req.param('mirrorId');
    if (id.startsWith('adjust:')) engine.skipAdjustment(id.slice('adjust:'.length), c.get('userId'));
    else engine.skip(id.replace(/^mirror:/, ''), c.get('userId'));
    return c.body(null, 204);
  });

  // Manual stack. `markerId` is a ChartMarker id or a bare leader trade id.
  cultRoutes.post('/:clanId/stack', async (c) => {
    const clan = clanFor(c);
    const body = z
      .object({ markerId: z.string(), notionalUsd: z.number().positive(), leverage: z.number().min(1).optional() })
      .parse(await c.req.json());
    const tradeId = resolveTradeId(body.markerId);
    const result = await stackOnTrade({ clanId: clan.id, userId: c.get('userId'), tradeId, notionalAusd: body.notionalUsd, leverage: body.leverage });
    return c.json(result, result.status === 'open' ? 200 : 502);
  });

  // Drag-to-suggest: propose a TP/SL on a clan-mate's Perpl marker. Stored and
  // pushed live; only the owner can apply it (via POST /v1/positions/tpsl).
  cultRoutes.post('/:clanId/markers/:markerId/suggest-tpsl', async (c) => {
    const clan = clanFor(c);
    const leg = z.number().positive().nullable().optional();
    const body = z.object({ takeProfit: leg, stopLoss: leg }).parse(await c.req.json());
    if (body.takeProfit == null && body.stopLoss == null) throw bad(400, 'suggest a take-profit, a stop-loss, or both');
    const markerId = c.req.param('markerId');
    const tradeId = resolveTradeId(markerId);
    const trade = trades.get(tradeId);
    if (!trade || trade.closedAt || !clans.membership(clan.id, trade.userId)) throw bad(404, 'marker not found');
    if (trade.venue !== 'perpl') throw bad(400, 'TP/SL is Perpl only');
    return c.json(addSuggestion(clan.id, tradeId, markerId, c.get('userId'), body.takeProfit ?? null, body.stopLoss ?? null), 201);
  });

  // Clan group chat. Members only; new messages also arrive as SSE `message`.
  cultRoutes.get('/:clanId/messages', (c) => {
    const clan = clanFor(c);
    const limit = c.req.query('limit');
    return c.json(listMessages(cultRoom(clan.id), { before: c.req.query('before') || undefined, limit: limit ? Number(limit) : undefined }));
  });

  cultRoutes.post('/:clanId/messages', async (c) => {
    const clan = clanFor(c);
    const body = z
      .object({ body: z.string().max(MAX_MESSAGE_CHARS * 2), replyTo: z.string().max(64).nullish(), markerId: z.string().max(128).nullish() })
      .parse(await c.req.json());
    return c.json(postMessage(cultRoom(clan.id), c.get('userId'), body), 201);
  });

  authed.post('/shares', async (c) => {
    const body = z.object({ markerId: z.string(), includeClan: z.boolean() }).parse(await c.req.json());
    return c.json(await createShare(c.get('userId'), body.markerId, body.includeClan), 201);
  });

  // Live updates for the chart overlay: marker changes as they happen.
  cultRoutes.get('/:clanId/events', (c) => {
    const clan = clanFor(c);
    const inClan = (userId: string) => !!clans.membership(clan.id, userId);
    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => void stream.writeSSE({ event, data: JSON.stringify(data) });
      const onTrade = (t: { userId: string }) => inClan(t.userId) && send('trade', t);
      const onChanged = (t: { userId: string }) => inClan(t.userId) && send('trade_changed', t);
      const onClosed = (t: { userId: string }) => inClan(t.userId) && send('trade_closed', t);
      const onMirror = (m: { clanId: string }) => m.clanId === clan.id && send('mirror', m);
      const onAdjust = (a: { clanId: string }) => a.clanId === clan.id && send('adjustment', a);
      engine.on('trade', onTrade);
      engine.on('tradeChanged', onChanged);
      engine.on('tradeClosed', onClosed);
      engine.on('mirror', onMirror);
      engine.on('adjustment', onAdjust);
      const onSuggestion = (clanId: string, sug: TpSlSuggestion) => clanId === clan.id && send('suggestion', sug);
      const onMessage = (room: string, msg: ChatMessage) => room === cultRoom(clan.id) && send('message', msg);
      clanBus.on('suggestion', onSuggestion);
      clanBus.on('message', onMessage);
      const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: String(Date.now()) }), 15_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      engine.off('trade', onTrade);
      engine.off('tradeChanged', onChanged);
      engine.off('tradeClosed', onClosed);
      engine.off('mirror', onMirror);
      engine.off('adjustment', onAdjust);
      clanBus.off('suggestion', onSuggestion);
      clanBus.off('message', onMessage);
    });
  });

  authed.route('/predictions', predictionRoutes());
  authed.route('/intents', intentRoutes());

  // MON for network fees before the app sends a transaction from the member's
  // wallet (perps setup, withdrawals, moving money to predictions).
  authed.post('/wallet/gas', async (c) => c.json(await ensureGas(c.get('wallet'))));

  // A plain send on Monad: wallet actions for the member to sign (the backend
  // can't move funds). Other chains: POST /v1/intents/withdraw.
  authed.post('/wallet/withdraw', async (c) => {
    const b = z.object({ symbol: z.enum(['MON', 'AUSD', 'USDC']), amount: z.number().positive(), to: z.string(), pin: z.string().optional() }).parse(await c.req.json());
    pins.check(c.get('userId'), b.pin);
    return c.json(await withdrawActions(c.get('userId'), { symbol: b.symbol, amount: b.amount, to: b.to }));
  });
  authed.route('/cults', cultRoutes);
  authed.route('/clans', cultRoutes);
  app.route('/v1', authed);
  return app;
}

// Balances for /v1/me. A wallet with dollars but no MON for fees gets topped
// up in the background (funding/gas.ts), so the first trade just works.
async function gasCheckedBalances(userId: string, wallet: string) {
  const b = await balancesFor(userId).catch(() => null);
  if (b?.lowGas && b.walletUsd >= 1) void ensureGas(wallet).catch(() => undefined);
  return b;
}

// What a member sees when their wallet can't pay a network fee.
const NO_GAS = 'Top up MON for gas.';

// A forgotten PIN can be reset this long after signing in again.
const PIN_RESET_WINDOW_MS = 10 * 60_000;

function remoteAddress(c: Context<Vars>): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined; // not behind the node server (e.g. app.request in scripts)
  }
}

function resolveTradeId(markerId: string): string {
  const [kind, id] = markerId.includes(':') ? markerId.split(':', 2) : ['trade', markerId];
  if (kind === 'trade') return id!;
  if (kind === 'mirror') {
    const m = mirrors.get(id!);
    if (m) return m.tradeId;
  }
  if (kind === 'stack') {
    const s = getDb().prepare('SELECT target_trade FROM stacks WHERE id = ?').get(id!) as { target_trade: string } | undefined;
    if (s) return s.target_trade;
  }
  if (trades.get(id!)) return id!;
  throw new MirrorError(404, 'marker not found');
}

// On Railway a service only keeps files across deploys on an attached volume
// (RAILWAY_VOLUME_MOUNT_PATH is set when one is). Without it the SQLite file,
// and every member, cult and chat in it, is wiped on each deploy.
export function storageStatus(): { host: 'railway' | 'other'; persistent: boolean | null } {
  if (!process.env.RAILWAY_PROJECT_ID) return { host: 'other', persistent: null };
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  return { host: 'railway', persistent: !!vol && resolve(env.dbPath).startsWith(resolve(vol)) };
}
