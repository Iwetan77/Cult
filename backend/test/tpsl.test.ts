import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTpSl } from '../src/trading/tpsl.js';
import { OrderType, PositionSide, TriggerCondition, type Order } from '../src/perpl/types.js';

const o = (over: Partial<Order>): Order =>
  ({ at: {}, c: {}, rq: 1, mkt: 16, acc: 1, oid: Math.floor(Math.random() * 1e6), st: 8, sr: 0, t: OrderType.CloseLong, os: 1, fp: 0, fs: 0, f: '0', lv: 0, ...over }) as Order;

test('long: GTE trigger is take-profit, LTE is stop-loss (price decimals applied)', () => {
  const r = readTpSl([o({ tp: 950000, tpc: TriggerCondition.GTEMark }), o({ tp: 800000, tpc: TriggerCondition.LTEMark })], 16, PositionSide.Long, 1);
  assert.equal(r.takeProfit, 95000);
  assert.equal(r.stopLoss, 80000);
  assert.equal(r.orderIds.length, 2);
});

test('short: inverted, LTE is take-profit, GTE is stop-loss', () => {
  const r = readTpSl(
    [o({ t: OrderType.CloseShort, tp: 800000, tpc: TriggerCondition.LTEMark }), o({ t: OrderType.CloseShort, tp: 950000, tpc: TriggerCondition.GTEMark })],
    16,
    PositionSide.Short,
    1,
  );
  assert.equal(r.takeProfit, 80000);
  assert.equal(r.stopLoss, 95000);
});

test('ignores other markets, plain orders, opens, and removed orders', () => {
  const r = readTpSl(
    [
      o({ mkt: 32, tp: 1, tpc: TriggerCondition.GTEMark }),
      o({ tp: 0 }),
      o({ t: OrderType.OpenLong, tp: 900000, tpc: TriggerCondition.GTEMark }),
      o({ tp: 900000, tpc: TriggerCondition.GTEMark, r: true }),
    ],
    16,
    PositionSide.Long,
    1,
  );
  assert.deepEqual(r, { takeProfit: null, stopLoss: null, orderIds: [] });
});
