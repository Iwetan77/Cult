import { randomUUID } from 'node:crypto';
import { getDb } from '../store/db.js';
import { seal, unseal } from '../store/crypto.js';

// prediction_accounts / prediction_positions (see store/db.ts).

export interface ClobCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export interface PredictionAccount {
  userId: string;
  owner: string;
  depositWallet: string;
  deployed: boolean;
  approvals: boolean;
  hasCreds: boolean;
  sessionAddress: string | null;
  sessionValidUntil: number | null; // unix seconds
  sessionRetryAt: number | null; // ms
}

interface AccountRow {
  user_id: string;
  owner: string;
  deposit_wallet: string;
  deployed: number;
  approvals: number;
  clob_creds: string | null;
  session_address: string | null;
  session_key: string | null;
  session_valid_until: number | null;
  session_retry_at: number | null;
}

const toAccount = (r: AccountRow): PredictionAccount => ({
  userId: r.user_id,
  owner: r.owner,
  depositWallet: r.deposit_wallet,
  deployed: r.deployed === 1,
  approvals: r.approvals === 1,
  hasCreds: !!r.clob_creds,
  sessionAddress: r.session_address,
  sessionValidUntil: r.session_valid_until,
  sessionRetryAt: r.session_retry_at,
});

export const predictionAccounts = {
  get(userId: string): PredictionAccount | null {
    const r = getDb().prepare('SELECT * FROM prediction_accounts WHERE user_id = ?').get(userId) as AccountRow | undefined;
    return r ? toAccount(r) : null;
  },

  // Create or refresh the row for this owner + wallet. A different owner (the
  // member changed wallets) starts the account over.
  ensure(userId: string, owner: string, depositWallet: string): PredictionAccount {
    const now = Date.now();
    const cur = this.get(userId);
    if (cur && cur.owner === owner.toLowerCase() && cur.depositWallet === depositWallet.toLowerCase()) return cur;
    getDb()
      .prepare(
        `INSERT INTO prediction_accounts (user_id, owner, deposit_wallet, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET owner = excluded.owner, deposit_wallet = excluded.deposit_wallet,
           deployed = 0, approvals = 0, clob_creds = NULL, session_address = NULL, session_key = NULL,
           session_valid_until = NULL, session_retry_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(userId, owner.toLowerCase(), depositWallet.toLowerCase(), now);
    return this.get(userId)!;
  },

  setDeployed(userId: string) {
    getDb().prepare('UPDATE prediction_accounts SET deployed = 1, updated_at = ? WHERE user_id = ?').run(Date.now(), userId);
  },

  setApprovals(userId: string, ok: boolean) {
    getDb().prepare('UPDATE prediction_accounts SET approvals = ?, updated_at = ? WHERE user_id = ?').run(ok ? 1 : 0, Date.now(), userId);
  },

  setCreds(userId: string, creds: ClobCreds) {
    getDb().prepare('UPDATE prediction_accounts SET clob_creds = ?, updated_at = ? WHERE user_id = ?').run(seal(Buffer.from(JSON.stringify(creds))), Date.now(), userId);
  },

  creds(userId: string): ClobCreds | null {
    const r = getDb().prepare('SELECT clob_creds FROM prediction_accounts WHERE user_id = ?').get(userId) as { clob_creds: string | null } | undefined;
    if (!r?.clob_creds) return null;
    try {
      return JSON.parse(Buffer.from(unseal(r.clob_creds)).toString()) as ClobCreds;
    } catch {
      return null;
    }
  },

  setSession(userId: string, address: string, privateKey: string, validUntil: number) {
    getDb()
      .prepare('UPDATE prediction_accounts SET session_address = ?, session_key = ?, session_valid_until = ?, session_retry_at = NULL, updated_at = ? WHERE user_id = ?')
      .run(address.toLowerCase(), seal(Buffer.from(privateKey.replace(/^0x/, ''), 'hex')), validUntil, Date.now(), userId);
  },

  clearSession(userId: string, retryAt: number | null) {
    getDb()
      .prepare('UPDATE prediction_accounts SET session_address = NULL, session_key = NULL, session_valid_until = NULL, session_retry_at = ?, updated_at = ? WHERE user_id = ?')
      .run(retryAt, Date.now(), userId);
  },

  sessionKey(userId: string): `0x${string}` | null {
    const r = getDb().prepare('SELECT session_key, session_valid_until FROM prediction_accounts WHERE user_id = ?').get(userId) as
      | { session_key: string | null; session_valid_until: number | null }
      | undefined;
    if (!r?.session_key || !r.session_valid_until || r.session_valid_until * 1000 < Date.now() + 60_000) return null;
    return `0x${Buffer.from(unseal(r.session_key)).toString('hex')}`;
  },
};

export interface PredictionRow {
  id: string;
  userId: string;
  marketId: string;
  conditionId: string;
  tokenId: string;
  side: 'yes' | 'no';
  sideLabel: string;
  eventSlug: string;
  eventTitle: string;
  outcomeLabel: string;
  question: string;
  image: string | null;
  negRisk: boolean;
  shares: number;
  costUsd: number;
  cultIds: string[] | null;
  openedAt: number;
  closedAt: number | null;
  closePrice: number | null;
  proceedsUsd: number | null;
}

interface PositionRow {
  id: string;
  user_id: string;
  market_id: string;
  condition_id: string;
  token_id: string;
  side: string;
  side_label: string;
  event_slug: string;
  event_title: string;
  outcome_label: string;
  question: string;
  image: string | null;
  neg_risk: number;
  shares: number;
  cost_usd: number;
  cult_ids: string | null;
  opened_at: number;
  closed_at: number | null;
  close_price: number | null;
  proceeds_usd: number | null;
}

const toPosition = (r: PositionRow): PredictionRow => ({
  id: r.id,
  userId: r.user_id,
  marketId: r.market_id,
  conditionId: r.condition_id,
  tokenId: r.token_id,
  side: r.side === 'no' ? 'no' : 'yes',
  sideLabel: r.side_label,
  eventSlug: r.event_slug,
  eventTitle: r.event_title,
  outcomeLabel: r.outcome_label,
  question: r.question,
  image: r.image,
  negRisk: r.neg_risk === 1,
  shares: r.shares,
  costUsd: r.cost_usd,
  cultIds: r.cult_ids ? (JSON.parse(r.cult_ids) as string[]) : null,
  openedAt: r.opened_at,
  closedAt: r.closed_at,
  closePrice: r.close_price,
  proceedsUsd: r.proceeds_usd,
});

export type NewFill = Omit<PredictionRow, 'id' | 'userId' | 'openedAt' | 'closedAt' | 'closePrice' | 'proceedsUsd'>;

export const predictionPositions = {
  get(id: string): PredictionRow | null {
    const r = getDb().prepare('SELECT * FROM prediction_positions WHERE id = ?').get(id) as PositionRow | undefined;
    return r ? toPosition(r) : null;
  },

  open(userId: string): PredictionRow[] {
    return (getDb().prepare('SELECT * FROM prediction_positions WHERE user_id = ? AND closed_at IS NULL ORDER BY opened_at DESC').all(userId) as unknown as PositionRow[]).map(toPosition);
  },

  closed(userId: string, limit = 50): PredictionRow[] {
    return (
      getDb().prepare('SELECT * FROM prediction_positions WHERE user_id = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT ?').all(userId, limit) as unknown as PositionRow[]
    ).map(toPosition);
  },

  // Everyone's open bets on one event (for "Cult bets").
  openOnEvent(eventSlug: string): PredictionRow[] {
    return (getDb().prepare('SELECT * FROM prediction_positions WHERE event_slug = ? AND closed_at IS NULL').all(eventSlug) as unknown as PositionRow[]).map(toPosition);
  },

  // A buy: adds to the open position on the same outcome token, or opens one.
  addFill(userId: string, fill: NewFill): PredictionRow {
    const db = getDb();
    const cur = db.prepare('SELECT * FROM prediction_positions WHERE user_id = ? AND token_id = ? AND closed_at IS NULL').get(userId, fill.tokenId) as PositionRow | undefined;
    if (cur) {
      db.prepare('UPDATE prediction_positions SET shares = shares + ?, cost_usd = cost_usd + ? WHERE id = ?').run(fill.shares, fill.costUsd, cur.id);
      return this.get(cur.id)!;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO prediction_positions (id, user_id, market_id, condition_id, token_id, side, side_label, event_slug, event_title,
         outcome_label, question, image, neg_risk, shares, cost_usd, cult_ids, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      fill.marketId,
      fill.conditionId,
      fill.tokenId,
      fill.side,
      fill.sideLabel,
      fill.eventSlug,
      fill.eventTitle,
      fill.outcomeLabel,
      fill.question,
      fill.image,
      fill.negRisk ? 1 : 0,
      fill.shares,
      fill.costUsd,
      fill.cultIds ? JSON.stringify(fill.cultIds) : null,
      Date.now(),
    );
    return this.get(id)!;
  },

  // Polymarket's own count of shares wins (fills after placement, redemptions).
  setShares(id: string, shares: number) {
    getDb().prepare('UPDATE prediction_positions SET shares = ? WHERE id = ?').run(shares, id);
  },

  // A sale of `shares` at an average of `price`. Selling (nearly) everything
  // closes the position; a part sale keeps it open with cost cut pro rata.
  sell(id: string, shares: number, proceedsUsd: number): { closed: boolean; costOfSold: number } {
    const p = this.get(id);
    if (!p) throw new Error('unknown position');
    const sold = Math.min(shares, p.shares);
    const costOfSold = p.shares > 0 ? (p.costUsd * sold) / p.shares : 0;
    const left = p.shares - sold;
    if (left <= Math.max(0.01, p.shares * 0.01)) {
      getDb()
        .prepare('UPDATE prediction_positions SET shares = ?, closed_at = ?, close_price = ?, proceeds_usd = COALESCE(proceeds_usd, 0) + ? WHERE id = ?')
        .run(sold, Date.now(), sold > 0 ? proceedsUsd / sold : null, proceedsUsd, id);
      return { closed: true, costOfSold: p.costUsd };
    }
    getDb()
      .prepare('UPDATE prediction_positions SET shares = ?, cost_usd = ?, proceeds_usd = COALESCE(proceeds_usd, 0) + ? WHERE id = ?')
      .run(left, p.costUsd - costOfSold, proceedsUsd, id);
    return { closed: false, costOfSold };
  },

  // Settled by resolution: winners redeem at $1, losers at $0.
  resolve(id: string, payoutPerShare: number) {
    const p = this.get(id);
    if (!p) return;
    getDb()
      .prepare('UPDATE prediction_positions SET closed_at = ?, close_price = ?, proceeds_usd = COALESCE(proceeds_usd, 0) + ? WHERE id = ?')
      .run(Date.now(), payoutPerShare, p.shares * payoutPerShare, id);
  },
};
