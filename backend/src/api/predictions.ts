import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { members } from '../store/members.js';
import { accountView, broker, fundPlan, startSetup, startWithdraw } from '../polymarket/account.js';
import { FlowError, type FlowStep } from '../polymarket/broker.js';
import { accessFor, countryOfIp } from '../polymarket/geo.js';
import { buy, cultBets, positions, redeem, sell } from '../polymarket/trading.js';

// /v1/predictions: Polymarket bets for members (see CONTRACTS.md, Predictions).
//
// Steps that need the member's own signature answer with a FlowStep:
//   { status: 'needs_signature', flowId, signature: { challengeId, label, kind, typedData | message } }
//     -> sign it (eth_signTypedData_v4 / personal_sign) and POST /predictions/sign
//   { status: 'working', flowId, label }  -> GET /predictions/flows/:flowId
//   { status: 'done', flowId, result }
// POST /orders and /sell answer with the plain result (200) when nothing needs
// signing (our session key placed it), or 202 + a FlowStep when it does.

type Vars = { Variables: { userId: string; wallet: string } };

export function predictionRoutes() {
  const r = new Hono<Vars>();

  // The member's country, from the IP their request came from; the country
  // they picked in the app when the lookup fails.
  const country = async (c: Context<Vars>) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null;
    return (await countryOfIp(ip)) ?? members.get(c.get('userId'))?.country ?? null;
  };

  const step = <T>(c: Context<Vars>, s: FlowStep<T>, plain = false) =>
    plain && s.status === 'done' ? c.json(s.result as object) : c.json(s as object, s.status === 'done' ? 200 : 202);

  r.onError((err, c) => {
    if (err instanceof FlowError) {
      const m = /^(needs_setup|needs_funds): (.*)$/.exec(err.message);
      return c.json(m ? { message: m[2], code: m[1] } : { message: err.message }, err.status);
    }
    if (err instanceof z.ZodError) return c.json({ message: 'invalid request', issues: err.issues }, 400);
    const name = (err as { name?: string }).name ?? '';
    if (/CancelledSigning/.test(name)) return c.json({ message: 'Cancelled in your wallet.' }, 409);
    if (/RateLimit/.test(name)) return c.json({ message: 'Polymarket is busy, try again in a moment.' }, 503);
    if (/Transport|Timeout|UnexpectedResponse/.test(name)) return c.json({ message: 'Polymarket is unreachable right now, try again shortly.' }, 503);
    if (/RequestRejected|TransactionFailed|UserInput|Signing|Invariant/.test(name)) {
      console.warn(`[predictions] ${name}: ${err.message}`);
      return c.json({ message: `Polymarket said no: ${err.message.slice(0, 200)}` }, 409);
    }
    console.error('[predictions]', err);
    return c.json({ message: 'internal error' }, 500);
  });

  r.get('/account', async (c) => {
    const [view, where] = await Promise.all([accountView(c.get('userId')), country(c)]);
    return c.json({ ...view, access: accessFor(where) });
  });

  r.post('/setup', async (c) => step(c, await startSetup(c.get('userId'))));

  r.post('/sign', async (c) => {
    const b = z.object({ flowId: z.string(), challengeId: z.string(), signature: z.string() }).parse(await c.req.json());
    return step(c, await broker.resume(c.get('userId'), b.flowId, b.challengeId, b.signature));
  });

  r.get('/flows/:flowId', async (c) => step(c, await broker.poll(c.get('userId'), c.req.param('flowId'))));

  r.delete('/flows', (c) => {
    broker.cancel(c.get('userId'));
    return c.body(null, 204);
  });

  // Move dollars from the Cult wallet (Monad) into predictions: wallet actions to sign.
  r.post('/fund', async (c) => {
    const b = z.object({ amountUsd: z.number().positive() }).parse(await c.req.json());
    return c.json(await fundPlan(c.get('userId'), b.amountUsd));
  });

  // And back.
  r.post('/withdraw', async (c) => {
    const b = z.object({ amountUsd: z.number().positive() }).parse(await c.req.json());
    return step(c, await startWithdraw(c.get('userId'), b.amountUsd));
  });

  r.get('/positions', async (c) => c.json(await positions(c.get('userId'))));

  const Order = z.object({
    marketId: z.string().min(1).max(32),
    eventSlug: z.string().min(1).max(300),
    eventTitle: z.string().max(400),
    outcomeLabel: z.string().max(400),
    question: z.string().max(400),
    image: z.string().max(2000).nullable(),
    side: z.enum(['yes', 'no']),
    sideLabel: z.string().max(100),
    price: z.number(),
    amountUsd: z.number(),
    cultIds: z.array(z.string()).max(50).optional(),
  });

  r.post('/orders', async (c) => {
    const order = Order.parse(await c.req.json());
    return step(c, await buy(c.get('userId'), order, await country(c)), true);
  });

  r.post('/sell', async (c) => {
    const b = z.object({ positionId: z.string(), price: z.number() }).parse(await c.req.json());
    return step(c, await sell(c.get('userId'), b.positionId, b.price, await country(c)), true);
  });

  r.post('/redeem', async (c) => {
    const b = z.object({ positionId: z.string() }).parse(await c.req.json());
    return step(c, await redeem(c.get('userId'), b.positionId));
  });

  // Cult-mates' bets on an event. `outcomes` is accepted for the demo's shape
  // and ignored: real bets come from what members actually placed.
  r.post('/bets', async (c) => {
    const b = z.object({ eventSlug: z.string().min(1).max(300) }).passthrough().parse(await c.req.json());
    return c.json({ bets: cultBets(c.get('userId'), b.eventSlug) });
  });

  return r;
}
