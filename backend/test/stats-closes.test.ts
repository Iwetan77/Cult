import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

const { toStats, closedTrades } = await import('../src/indexer/stats.js');
type Row = import('../src/indexer/stats.js').TraderRow;

const W = '0xaaaa0000000000000000000000000000000000ff';
const perp = (o: Partial<Row['trades'][number]>) => ({ openTx: '0xopen', closeTx: '0xclose', realizedPnlUsd: '1', isWin: true, closedAt: '1790000000000', marketId: '48', symbol: 'SOL', side: 'LONG', entryPrice: '150', exitPrice: '150', notionalUsd: '100', ...o });

test('the revision moves with every close, even a $0.00 one', () => {
  const before = toStats({ id: W, trades: [perp({})], nadFunTrades: [] }, 1, new Set());
  const after = toStats({ id: W, trades: [perp({}), perp({ realizedPnlUsd: '0', isWin: false, closedAt: '1790000000500', closeTx: '0xclose2' })], nadFunTrades: [] }, 1, new Set());
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.realizedPnlUsd, before.realizedPnlUsd, 'same PnL, still a new revision');
});

test('a winning close never shows a negative return (funding can outweigh the price move)', () => {
  // Price fell 150 -> 149.85 on a long, but funding received made it +$0.30.
  const row: Row = { id: W, trades: [perp({ entryPrice: '150', exitPrice: '149.85', realizedPnlUsd: '0.3', isWin: true, notionalUsd: '300' })], nadFunTrades: [] };
  const [t] = closedTrades(row, 1, new Set());
  assert.ok(t!.returnPct! > 0, `returnPct ${t!.returnPct}`);
  assert.equal(Math.round(t!.returnPct! * 100) / 100, 0.1);
  assert.ok(toStats(row, 1, new Set()).avgWinPct! > 0);
});

test("a copy's exit out of a position the member also holds counts as copied", () => {
  const row: Row = { id: W, trades: [perp({ openTx: '0xmine', closeTx: '0xCOPYEXIT' }), perp({ openTx: '0xmine', closeTx: '0xmyclose', closedAt: '1790000001000' })], nadFunTrades: [] };
  const stats = toStats(row, 1, new Set(['0xcopyexit']));
  assert.equal(stats.tradeCount, 1);
  assert.equal(stats.copied.tradeCount, 1);
  assert.deepEqual(closedTrades(row, 1, new Set(['0xcopyexit'])).map((t) => t.copied), [false, true]);
});

test('a position closed in three parts reads as one trade where a feed shows positions', async () => {
  const { combineCloses } = await import('../src/indexer/stats.js');
  const row: Row = {
    id: W,
    trades: [
      perp({ closeTx: '0xa', realizedPnlUsd: '2.4', isWin: true, notionalUsd: '75', closedAt: '1790000001000' }),
      perp({ closeTx: '0xb', realizedPnlUsd: '-1', isWin: false, notionalUsd: '75', closedAt: '1790000002000' }),
      perp({ closeTx: '0xc', realizedPnlUsd: '10', isWin: true, notionalUsd: '150', closedAt: '1790000003000' }),
      perp({ openTx: '0xother', closeTx: '0xd', realizedPnlUsd: '-3', isWin: false, notionalUsd: '100', closedAt: '1790000000500' }),
    ],
    nadFunTrades: [],
  };
  const each = closedTrades(row, 1, new Set());
  assert.equal(each.length, 4, 'every close is listed and counted');
  assert.equal(toStats(row, 1, new Set()).tradeCount, 4);
  const positions = combineCloses(each);
  assert.equal(positions.length, 2);
  const [sol] = positions;
  assert.equal(sol!.openTx, '0xopen');
  assert.equal(Math.round(sol!.pnlUsd! * 100) / 100, 11.4);
  assert.equal(sol!.costUsd, 300);
  assert.equal(Math.round(sol!.returnPct! * 100) / 100, 3.8);
  assert.equal(sol!.isWin, true);
  assert.equal(sol!.closedAt, 1790000003000);
});
