import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { rpc } from '../chain/signer.js';
import { getDb } from '../store/db.js';
import { NADFUN } from './constants.js';
import { routerAbi } from './trading.js';

// Nad.fun has no per-user websocket like Perpl, so leader detection for memes
// reads the router's own Buy/Sell logs, filtered to clan members' wallets
// (topic1 = buyer/seller). Polls in <=100-block windows and remembers how far
// it got, so a restart neither misses nor replays trades.

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
const MAX_RANGE = 100;

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
      try {
        await this.poll();
      } catch (e) {
        console.error('[nadfun watcher]', (e as Error).message);
      }
      if (this.running) this.timer = setTimeout(loop, this.pollMs);
    };
    void loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  private async poll() {
    const db = getDb();
    const from = (db.prepare('SELECT value FROM cursors WHERE name = ?').get(CURSOR) as { value: number }).value + 1;
    const head = await rpc().getBlockNumber();
    if (from > head) return;
    const to = Math.min(head, from + MAX_RANGE - 1);
    if (this.wallets.size > 0) {
      const walletTopics = [...this.wallets].map((w) => ethers.zeroPadValue(w, 32));
      const logs = await rpc().getLogs({ address: NADFUN.router, fromBlock: from, toBlock: to, topics: [[BUY, SELL], walletTopics] });
      const times = new Map<number, number>();
      for (const log of logs) {
        if (!times.has(log.blockNumber)) times.set(log.blockNumber, ((await rpc().getBlock(log.blockNumber))?.timestamp ?? 0) * 1000);
      }
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
  }
}
