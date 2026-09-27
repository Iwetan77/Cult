import { numEnv } from '../config/env.js';
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { rpc } from '../chain/signer.js';
import { getDb } from '../store/db.js';
import { NADFUN } from './constants.js';
import { routerAbi } from './trading.js';

// Nad.fun has no per-user websocket like Perpl, so leader detection for memes
// reads the router's own Buy/Sell logs, filtered to clan members' wallets
// (topic1 = buyer/seller). Polls in <=100-block windows and remembers how far
// it got, so a restart neither misses nor replays trades. When it's behind
// (after downtime) it reads window after window without waiting, so exits
// that happened meanwhile unwind and new trades are seen again quickly.

export interface NadTradeEvent {
  side: 'buy' | 'sell';
  wallet: string; // lowercase
  token: string; // lowercase
  monAmount: bigint; // buy: MON in, sell: MON out
  tokenAmount: bigint; // buy: tokens out, sell: tokens in
  txHash: string;
  blockNumber: number;
  blockTime: number; // ms
}

const BUY = routerAbi.getEvent('Buy')!.topicHash;
const SELL = routerAbi.getEvent('Sell')!.topicHash;
const CURSOR = 'nadfun_router';
const MAX_RANGE = 100; // blocks per eth_getLogs (the RPC's cap)
const PARALLEL_WINDOWS = numEnv('NADFUN_WATCHER_PARALLEL', 6);

export class NadWatcher extends EventEmitter<{ trade: [NadTradeEvent] }> {
  private wallets = new Set<string>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly pollMs = 1500) {
    super();
  }

  add(wallet: string) {
    this.wallets.add(wallet.toLowerCase());
  }

  async start() {
    if (this.running) return;
    this.running = true;
    const db = getDb();
    const row = db.prepare('SELECT value FROM cursors WHERE name = ?').get(CURSOR) as { value: number } | undefined;
    if (!row) {
      // First start: begin at the head. History before Cult isn't a trade to mirror.
      db.prepare('INSERT INTO cursors (name, value) VALUES (?, ?)').run(CURSOR, await rpc().getBlockNumber());
    }
    const loop = async () => {
      let behind = false;
      try {
        behind = await this.poll();
      } catch (e) {
        console.error('[nadfun watcher]', (e as Error).message);
      }
      if (this.running) this.timer = setTimeout(loop, behind ? 0 : this.pollMs);
    };
    void loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  // Reads the next windows (several in parallel when behind, emitted in block
  // order). Returns true while still behind the head.
  private async poll(): Promise<boolean> {
    const db = getDb();
    const from = (db.prepare('SELECT value FROM cursors WHERE name = ?').get(CURSOR) as { value: number }).value + 1;
    const head = await rpc().getBlockNumber();
    if (from > head) return false;
    const to = Math.min(head, from + MAX_RANGE * PARALLEL_WINDOWS - 1);
    if (this.wallets.size > 0) {
      const walletTopics = [...this.wallets].map((w) => ethers.zeroPadValue(w, 32));
      const windows: [number, number][] = [];
      for (let a = from; a <= to; a += MAX_RANGE) windows.push([a, Math.min(to, a + MAX_RANGE - 1)]);
      const logs = (
        await Promise.all(windows.map(([a, b]) => rpc().getLogs({ address: NADFUN.router, fromBlock: a, toBlock: b, topics: [[BUY, SELL], walletTopics] })))
      ).flat();
      const times = new Map<number, number>();
      await Promise.all(
        [...new Set(logs.map((l) => l.blockNumber))].map(async (n) => times.set(n, ((await rpc().getBlock(n))?.timestamp ?? 0) * 1000)),
      );
      for (const log of logs) {
        const ev = routerAbi.parseLog(log);
        if (!ev) continue;
        const isBuy = ev.name === 'Buy';
        this.emit('trade', {
          side: isBuy ? 'buy' : 'sell',
          wallet: (ev.args[0] as string).toLowerCase(),
          token: (ev.args[1] as string).toLowerCase(),
          monAmount: isBuy ? (ev.args[2] as bigint) : (ev.args[3] as bigint),
          tokenAmount: isBuy ? (ev.args[3] as bigint) : (ev.args[2] as bigint),
          txHash: log.transactionHash.toLowerCase(),
          blockNumber: log.blockNumber,
          blockTime: times.get(log.blockNumber) ?? 0,
        });
      }
    }
    db.prepare('UPDATE cursors SET value = ? WHERE name = ?').run(to, CURSOR);
    return to < head;
  }

  // How many blocks behind the head the watcher is (0 = caught up).
  async lag(): Promise<number> {
    const row = getDb().prepare('SELECT value FROM cursors WHERE name = ?').get(CURSOR) as { value: number } | undefined;
    return row ? Math.max(0, (await rpc().getBlockNumber()) - row.value) : 0;
  }
}
