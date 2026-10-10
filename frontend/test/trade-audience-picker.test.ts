import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tradeAudienceFromDefault, tradeAudienceIds, toggleTradeAudience } from '../src/components/TradeAudiencePicker';

const cults = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }];

test('the existing default cult, all and private choices keep their API meanings', () => {
  assert.deepEqual(tradeAudienceIds(tradeAudienceFromDefault('a'), cults), ['a']);
  assert.equal(tradeAudienceIds(tradeAudienceFromDefault('all'), cults), undefined);
  assert.deepEqual(tradeAudienceIds(tradeAudienceFromDefault('none'), cults), []);
});

test('choosing a cult from all starts an explicit audience and supports adding another', () => {
  const first = toggleTradeAudience('all', 'b', cults);
  assert.deepEqual(tradeAudienceIds(first, cults), ['b']);
  assert.deepEqual(tradeAudienceIds(toggleTradeAudience(first, 'a', cults), cults), ['b', 'a']);
});

test('deselecting the last explicit cult makes the trade private', () => {
  assert.deepEqual(tradeAudienceIds(toggleTradeAudience(['b'], 'b', cults), cults), []);
  assert.deepEqual(tradeAudienceIds(toggleTradeAudience([], 'a', cults), cults), ['a']);
});

test('explicitly choosing every cult still sends an array rather than all', () => {
  const selected = cults.reduce((value, cult) => toggleTradeAudience(value, cult.id, cults), [] as ReturnType<typeof tradeAudienceFromDefault>);
  assert.deepEqual(tradeAudienceIds(selected, cults), ['a', 'b', 'c']);
});

test('lost eligibility removes selected ids without widening the audience', () => {
  assert.deepEqual(tradeAudienceIds(['a', 'b'], [cults[0]!]), ['a']);
  assert.deepEqual(tradeAudienceIds(['missing'], cults), []);
  assert.deepEqual(tradeAudienceIds(['a'], []), []);
  assert.deepEqual(tradeAudienceIds('all', []), []);
});

test('ineligible ids cannot be selected and repeated ids are sent only once', () => {
  assert.deepEqual(toggleTradeAudience(['a'], 'missing', cults), ['a']);
  assert.equal(toggleTradeAudience('all', 'missing', cults), 'all');
  assert.deepEqual(tradeAudienceIds(['b', 'b', 'missing', 'a'], cults), ['b', 'a']);
});
