import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { completeEnrollment, setupStatus, startEnrollment } from '../accounts/client-flow.js';
import { sessionFor } from '../accounts/lifecycle.js';
import { env } from '../config/env.js';
import { MirrorError, type MirrorEngine } from '../mirror/engine.js';
import { mirrors, trades } from '../mirror/repo.js';
import { stackOnTrade } from '../mirror/stack.js';
import { getContext, getMarket } from '../perpl/context.js';
import { listMonMarkets } from '../nadfun/trading.js';
import { monPriceAusd } from '../prices.js';
import { venue, venueOf } from '../venues/index.js';
import { AuthError, identify } from '../privy/auth.js';
import { memberSignerGrant } from '../privy/policy.js';
import { clans, MirrorPolicySchema, type MirrorPolicy } from '../store/clans.js';
import { getDb } from '../store/db.js';
import { members } from '../store/members.js';
import { buildChart, shortName, toApiMarket } from './chart.js';
import { heldMarkets } from './holdings.js';
import { UpstreamError } from '../http.js';
import { balancesFor } from './balances.js';
import { createShare, getShare, ShareError } from './shares.js';
import { addSuggestion, clanBus, type TpSlSuggestion } from './suggestions.js';
import { setTpSl, TpSlError } from '../trading/tpsl.js';
import { confirmFunding, FundingUnavailable, prepareUsdcFunding } from '../funding/plan.js';

type Vars = { Variables: { userId: string; wallet: string } };

const joinChallenges = new Map<string, { userId: string; clanId: string; policy: MirrorPolicy; message: string; expires: number }>();

function consentMessage(clanName: string, inviteCode: string, wallet: string, p: MirrorPolicy, nonce: string) {
  return [
    `Join Cult clan "${clanName}" (${inviteCode})`,
    `Wallet: ${wallet}`,
    ``,
    p.enabled
      ? `When any member of this clan opens a Perpl position, open a mirrored position on my account automatically.`
      : `Do not auto-mirror trades into my account.`,
    `Max margin per mirror: ${p.balancePercentCap}% of my free Perpl balance.`,
    `Max position size per mirror: $${p.maxUsdPerTrade}.`,
    `When the original position closes, close my mirror too.`,
    `I can skip any single trade before it fires. The backend can never withdraw my funds.`,
    ``,
    `Nonce: ${nonce}`,
  ].join('\n');
}

export function createApp(engine: MirrorEngine) {
  const app = new Hono<Vars>();
  app.use('*', cors({ origin: env.corsOrigins, allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST'] }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ message: err.message }, err.status);
    if (err instanceof AuthError) return c.json({ message: err.message }, 401);
    if (err instanceof MirrorError) return c.json({ message: err.message }, err.status as 400);
    if (err instanceof ShareError) return c.json({ message: err.message }, err.status);
    if (err instanceof TpSlError) return c.json({ message: err.message }, 400);
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

  app.get('/v1/config', async (c) => {
    const ctx = await getContext();
    return c.json({
      chainId: env.chainId,
      venues: ['perpl', 'nadfun'],
      displayUnit: 'USD', // show $ everywhere; the word AUSD only appears on the funding screen
      monPriceAusd: await monPriceAusd().catch(() => null),
      autoMirrorOptOutWindowSeconds: env.mirrorOptOutSeconds,
      mirrorPolicyBounds: { balancePercentCap: { min: 0, minExclusive: true, max: 100 }, maxUsdPerTrade: { min: 1, max: 1_000_000 } },
      markets: ctx.markets.filter((m) => m.config.is_open).map(toApiMarket),
    });
  });

  // Public share card. No auth, no clan identity unless opted in.
  app.get('/v1/shares/:id', (c) => {
    const share = getShare(c.req.param('id'));
    if (!share) throw bad(404, 'share not found');
    return c.json(share);
  });

  // Nad.fun tokens Cult can trade (MON-quoted only), for the market picker.
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
                COALESCE(mi.clan_id, st.clan_id) AS clan_id,
                COALESCE(mi.trade_id, st.target_trade) AS trade_id
         FROM engine_orders e
         LEFT JOIN mirrors mi ON e.kind LIKE 'mirror%' AND mi.id = e.ref_id
         LEFT JOIN stacks st ON e.kind LIKE 'stack%' AND st.id = e.ref_id
         WHERE e.created_at > ? ORDER BY e.created_at LIMIT 1000`,
      )
      .all(since) as { account_id: number; rq: number; kind: string; ref_id: string; created_at: number; clan_id: string; trade_id: string }[];
    return c.json({
      orders: rows.map((r) => ({
        perplAccountId: r.account_id,
        requestId: r.rq,
        kind: r.kind,
        refId: r.ref_id,
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
                COALESCE(mi.clan_id, st.clan_id) AS clan_id,
                COALESCE(mi.trade_id, st.target_trade) AS trade_id
         FROM engine_txs e
         LEFT JOIN mirrors mi ON e.kind LIKE 'mirror%' AND mi.id = e.ref_id
         LEFT JOIN stacks st ON e.kind LIKE 'stack%' AND st.id = e.ref_id
         WHERE e.created_at > ? ORDER BY e.created_at LIMIT 1000`,
      )
      .all(since) as { tx_hash: string; wallet: string; kind: string; ref_id: string; created_at: number; clan_id: string; trade_id: string }[];
    return c.json({
      txs: rows.map((r) => ({ venue: 'nadfun', txHash: r.tx_hash, wallet: r.wallet, kind: r.kind, refId: r.ref_id, clanId: r.clan_id, tradeId: r.trade_id, createdAt: r.created_at })),
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
    if (!id.wallet) throw bad(409, 'no Privy embedded wallet on this user yet');
    members.upsert(id.userId, id.wallet, id.walletId);
    c.set('userId', id.userId);
    c.set('wallet', id.wallet.toLowerCase());
    await next();
  });

  const clanFor = (c: Context<Vars>) => {
    const clan = clans.get(c.req.param('clanId')!);
    if (!clan || !clans.membership(clan.id, c.get('userId'))) throw bad(404, 'clan not found');
    return clan;
  };
  const clanView = (clanId: string, userId: string) => {
    const clan = clans.get(clanId)!;
    return {
      id: clan.id,
      name: clan.name,
      inviteCode: clan.inviteCode,
      memberCount: clans.members(clan.id).length,
      myPolicy: clans.membership(clan.id, userId)?.policy ?? null,
    };
  };

  authed.get('/me', async (c) => {
    const userId = c.get('userId');
    const m = members.get(userId)!;
    return c.json({
      id: userId,
      address: m.wallet,
      name: shortName(m.wallet),
      clans: clans.forUser(userId).map((cl) => clanView(cl.id, userId)),
      perpl: { accountId: m.perplAccountId, keyEnrolled: !!m.apiKey, forwarding: m.forwarding },
      balances: await balancesFor(userId).catch(() => null),
      signerGranted: !!m.privyPolicyId,
    });
  });

  // What the frontend passes to Privy's useSigners().addSigners() so the
  // backend can act on this wallet, only within the policy.
  authed.get('/privy/signer', async (c) => {
    const userId = c.get('userId');
    const caps = clans.forUser(userId).map((cl) => clans.membership(cl.id, userId)!.policy.maxUsdPerTrade);
    if (caps.length === 0) throw bad(409, 'join or create a clan first; the cap comes from your clan policy');
    return c.json(await memberSignerGrant(userId, c.get('wallet'), Math.max(...caps)));
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
      })
      .parse(await c.req.json());
    const userId = c.get('userId');
    const m = members.get(userId)!;
    const v = venueOf(body.marketId);
    if (v === 'perpl') {
      if (!m.perplAccountId || !m.forwarding) throw bad(409, 'finish Perpl setup first');
      if (body.side === 'buy') throw bad(400, 'perpl side must be long or short');
      await getMarket(Number(body.marketId));
    } else if (body.side !== 'buy') throw bad(400, 'nad.fun side must be buy');
    const fill = await venue(v).open({ userId, market: body.marketId, side: body.side, notionalAusd: body.marginUsd * body.leverage, leverage: body.leverage });
    return c.json(fill);
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
    return c.json(await setTpSl(await sessionFor(userId), m.perplAccountId, Number(body.marketId), { takeProfit: body.takeProfit, stopLoss: body.stopLoss }));
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

  // ---- clans ---------------------------------------------------------------

  authed.post('/clans', async (c) => {
    const body = z.object({ name: z.string().min(1).max(48), policy: MirrorPolicySchema }).parse(await c.req.json());
    const clan = clans.create(body.name, c.get('userId'), body.policy);
    await engine.watch(c.get('userId')).catch(() => undefined);
    return c.json(clanView(clan.id, c.get('userId')), 201);
  });

  authed.post('/clans/join/challenge', async (c) => {
    const body = z.object({ inviteCode: z.string(), policy: MirrorPolicySchema }).parse(await c.req.json());
    const clan = clans.byInvite(body.inviteCode);
    if (!clan) throw bad(404, 'invite not found');
    const challengeId = randomUUID();
    const message = consentMessage(clan.name, clan.inviteCode, ethers.getAddress(c.get('wallet')), body.policy, challengeId);
    joinChallenges.set(challengeId, { userId: c.get('userId'), clanId: clan.id, policy: body.policy, message, expires: Date.now() + 10 * 60_000 });
    return c.json({ challengeId, message });
  });

  authed.post('/clans/join', async (c) => {
    const body = z.object({ challengeId: z.string(), signature: z.string() }).parse(await c.req.json());
    const ch = joinChallenges.get(body.challengeId);
    if (!ch || ch.userId !== c.get('userId') || Date.now() > ch.expires) throw bad(400, 'challenge missing or expired');
    const signer = ethers.verifyMessage(ch.message, body.signature);
    if (signer.toLowerCase() !== c.get('wallet')) throw bad(403, 'signature is not from your wallet');
    clans.join(ch.clanId, ch.userId, ch.policy);
    getDb()
      .prepare('INSERT OR REPLACE INTO join_consents (clan_id, user_id, message, signature, signed_at) VALUES (?, ?, ?, ?, ?)')
      .run(ch.clanId, ch.userId, ch.message, body.signature, Date.now());
    joinChallenges.delete(body.challengeId);
    await engine.watch(ch.userId).catch(() => undefined);
    return c.json(clanView(ch.clanId, ch.userId));
  });

  authed.get('/clans/:clanId/chart', async (c) => {
    const clan = clanFor(c);
    const marketId = c.req.query('marketId');
    const resolution = Number(c.req.query('resolution') ?? 300);
    return c.json(await buildChart(clan, c.get('userId'), marketId || undefined, resolution));
  });

  authed.post('/clans/:clanId/mirrors/:mirrorId/skip', async (c) => {
    clanFor(c);
    // Accept the bare mirror id or the chart marker id ("mirror:<id>").
    engine.skip(c.req.param('mirrorId').replace(/^mirror:/, ''), c.get('userId'));
    return c.body(null, 204);
  });

  // Manual stack. `markerId` is a ChartMarker id or a bare leader trade id.
  authed.post('/clans/:clanId/stack', async (c) => {
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
  authed.post('/clans/:clanId/markers/:markerId/suggest-tpsl', async (c) => {
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

  authed.post('/shares', async (c) => {
    const body = z.object({ markerId: z.string(), includeClan: z.boolean() }).parse(await c.req.json());
    return c.json(await createShare(c.get('userId'), body.markerId, body.includeClan), 201);
  });

  // Live updates for the chart overlay: marker changes as they happen.
  authed.get('/clans/:clanId/events', (c) => {
    const clan = clanFor(c);
    const inClan = (userId: string) => !!clans.membership(clan.id, userId);
    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => void stream.writeSSE({ event, data: JSON.stringify(data) });
      const onTrade = (t: { userId: string }) => inClan(t.userId) && send('trade', t);
      const onClosed = (t: { userId: string }) => inClan(t.userId) && send('trade_closed', t);
      const onMirror = (m: { clanId: string }) => m.clanId === clan.id && send('mirror', m);
      engine.on('trade', onTrade);
      engine.on('tradeClosed', onClosed);
      engine.on('mirror', onMirror);
      const onSuggestion = (clanId: string, sug: TpSlSuggestion) => clanId === clan.id && send('suggestion', sug);
      clanBus.on('suggestion', onSuggestion);
      const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: String(Date.now()) }), 15_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      engine.off('trade', onTrade);
      engine.off('tradeClosed', onClosed);
      engine.off('mirror', onMirror);
      clanBus.off('suggestion', onSuggestion);
    });
  });

  app.route('/v1', authed);
  return app;
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
