import { allowOrderForwarding, collateralBalance, createAccount, getOnChainAccount } from '../chain/exchange.js';
import type { WalletSigner } from '../chain/signer.js';
import { getExchangeInfo } from '../perpl/context.js';
import { enrollApiKey, SCOPE_TRADE } from '../perpl/enroll.js';
import { PerplRest } from '../perpl/rest.js';
import { TradingSession } from '../perpl/session.js';
import { members, type Member } from '../store/members.js';
import type { Account } from '../perpl/types.js';

export interface OnboardResult {
  member: Member;
  accountId: number;
  txs: { approve?: string; createAccount?: string; allowForwarding?: string };
  enrolledNewKey: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Idempotent: every step checks real state (chain / Perpl API) before acting,
// so re-running after a crash picks up where it stopped.
//   1. on-chain Perpl account, opened with `initialDeposit` AUSD
//   2. trade-scoped Ed25519 key, wallet-authorized once, secret kept by us
//   3. order forwarding on, so API orders are accepted
export async function onboardMember(
  userId: string,
  signer: WalletSigner,
  opts: { initialDeposit?: bigint; privyWalletId?: string } = {},
): Promise<OnboardResult> {
  let member = members.upsert(userId, signer.address, opts.privyWalletId ?? null);
  const txs: OnboardResult['txs'] = {};

  let onchain = await getOnChainAccount(signer.address);
  if (!onchain) {
    const { minAccountOpen } = await getExchangeInfo();
    const amount = opts.initialDeposit ?? minAccountOpen;
    const bal = await collateralBalance(signer.address);
    if (bal < amount) throw new Error(`wallet ${signer.address} holds ${bal} raw AUSD, needs ${amount} to open a Perpl account`);
    const { approveTx, createTx } = await createAccount(signer, amount);
    if (approveTx) txs.approve = approveTx;
    txs.createAccount = createTx;
    onchain = await getOnChainAccount(signer.address);
    if (!onchain) throw new Error(`createAccount ${createTx} mined but getAccountByAddr still empty`);
  }
  const accountId = Number(onchain.accountId);
  members.setAccount(userId, accountId);

  let enrolledNewKey = false;
  if (!members.credentials(userId)) {
    // Perpl's API needs a moment to index the new account before /enroll finds the profile.
    let lastErr: unknown;
    for (let i = 0; i < 10; i++) {
      try {
        const key = await enrollApiKey(signer, `cult:${userId}`.slice(0, 64), SCOPE_TRADE);
        members.setApiKey(userId, key.apiKey, key.secret, key.publicKey);
        enrolledNewKey = true;
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        if (!String(e).includes('-> 404')) throw e;
        await sleep(3000);
      }
    }
    if (lastErr) throw lastErr;
  }

  const rest = new PerplRest(members.credentials(userId)!);
  const acct = await waitForApiAccount(rest, accountId);
  if (!acct.fw) {
    txs.allowForwarding = await allowOrderForwarding(signer, true);
    await waitFor(async () => (await waitForApiAccount(rest, accountId)).fw, 'order forwarding to show fw=true');
  }
  members.setForwarding(userId, true);

  member = members.get(userId)!;
  return { member, accountId, txs, enrolledNewKey };
}

async function waitForApiAccount(rest: PerplRest, accountId: number) {
  let found: Account | undefined;
  await waitFor(async () => {
    try {
      const w = await rest.wallet();
      const a = w.as?.find((x) => x.id === accountId);
      if (a) found = a;
      return !!a;
    } catch (e) {
      if (String(e).includes('-> 404')) return false;
      throw e;
    }
  }, `Perpl API to index account ${accountId}`);
  return found!;
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// One live trading session per member, shared by everything in the process.
const sessions = new Map<string, TradingSession>();

export async function sessionFor(userId: string): Promise<TradingSession> {
  const existing = sessions.get(userId);
  if (existing) return existing;
  const creds = members.credentials(userId);
  if (!creds) throw new Error(`member ${userId} has no enrolled Perpl key`);
  const s = new TradingSession(creds, userId);
  sessions.set(userId, s);
  await s.start();
  return s;
}

export function restFor(userId: string): PerplRest {
  const creds = members.credentials(userId);
  if (!creds) throw new Error(`member ${userId} has no enrolled Perpl key`);
  return new PerplRest(creds);
}

export function stopAllSessions() {
  for (const s of sessions.values()) s.stop();
  sessions.clear();
}
