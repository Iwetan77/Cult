import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.KEY_ENCRYPTION_SECRET ??= '00'.repeat(32);

const { checkAddMargin } = await import('../src/trading/addMargin.js');
const { UnderwaterError } = await import('../src/funding/errors.js');
const { explain } = await import('../src/errors/friendly.js');
type Market = import('../src/perpl/types.js').Market;
type Position = import('../src/perpl/types.js').Position;

// Testnet SOL: price 2 dp, size 3 dp, initial_margin 1000 = 10x max.
const SOL = { id: 48, symbol: 'SOL', name: 'SOL Perp', config: { price_decimals: 2, size_decimals: 3, initial_margin: 1000 } } as unknown as Market;
// Long 1.000 SOL at 150.00 with $15 collateral (opened at 10x), collateral in 6 dp.
const pos = (c: number, sd = 1) => ({ s: 1000, ep: 15000, c: String(c * 1e6), sd }) as unknown as Position;

test('the reported case: a 10x copy onto your own SOL 10x that is down $0.55 is refused before sending', () => {
  assert.throws(() => checkAddMargin(pos(15), SOL, 149.45, 20, 10, 6), (e: unknown) => {
    assert.ok(e instanceof UnderwaterError);
    assert.match((e as Error).message, /SOL position is down \$0\.55/);
    assert.equal(explain(e)?.code, 'needs_margin');
    return true;
  });
});

test('the same add at lower leverage brings enough and goes through', () => {
  assert.doesNotThrow(() => checkAddMargin(pos(15), SOL, 149.45, 20, 5, 6));
});

test('adding to a winning position or one with spare collateral is never blocked', () => {
  assert.doesNotThrow(() => checkAddMargin(pos(15), SOL, 151, 20, 10, 6));
  assert.doesNotThrow(() => checkAddMargin(pos(75), SOL, 140, 20, 10, 6)); // opened at 2x, down $10
  assert.doesNotThrow(() => checkAddMargin(undefined, SOL, 140, 20, 10, 6)); // nothing held: a fresh open
});

test('a short that is down is measured the other way', () => {
  assert.throws(() => checkAddMargin(pos(15, 2), SOL, 150.6, 20, 10, 6), UnderwaterError);
  assert.doesNotThrow(() => checkAddMargin(pos(15, 2), SOL, 149, 20, 10, 6));
});
