// Crash recovery reads the chain back correctly: the real lookup the engine
// uses after a restart, run against real testnet txs from the Phase 4 Nad.fun
// run (commit 17f84cf). Read-only, costs nothing. Uses a throwaway in-memory DB.
process.env.DB_PATH = ':memory:';
const { getDb } = await import('../../src/store/db.js');
const { members } = await import('../../src/store/members.js');
const { recordEngineTx } = await import('../../src/mirror/origin.js');
const { landed } = await import('../../src/mirror/reconcile.js');

const B = '0x6bEf4B8D9f9000178d9dc3DE8c114B19375c7333';
const C = '0x252AC9Acdc29f438620471b2B76992829c8Db463';
members.upsert('B', B);
members.upsert('C', C);

type Case = { name: string; kind: 'mirror_open' | 'mirror_add' | 'mirror_reduce' | 'mirror_close'; user: string; tx: string; want: string };
const cases: Case[] = [
  { name: "B's mirror buy", kind: 'mirror_open', user: 'B', tx: '0x12a492bb91e72f12949b17f9b9405b3ca5953a2c0f023769c99bb06fb245b242', want: 'filled 1484785063824487928085' },
  { name: "B's half sell", kind: 'mirror_reduce', user: 'B', tx: '0xdb09d2d1f27fb7d2ce626df027596000c028077105063adb36add018314de623', want: 'filled 742392531912243964043' },
  { name: "B's add", kind: 'mirror_add', user: 'B', tx: '0x6de0c8fe64d5df411f64b5420985459ae2c5fa649668f464f988cefc3dcfd613', want: 'filled 712990406764577079385' },
  { name: "C's exit", kind: 'mirror_close', user: 'C', tx: '0x908155418ef9200de8e3fae13a71bd3f0c9a1e77f5b90dbdbc988fea95f82bd4', want: 'filled' },
  { name: "C's buy looked up for B (someone else's fill)", kind: 'mirror_open', user: 'B', tx: '0x5b50e7f0fde5bd08bde554bfb13fb657a0f435daa362c680c3fa349d00780443', want: 'none' },
  { name: 'a buy looked up as a sell', kind: 'mirror_reduce', user: 'B', tx: '0x12a492bb91e72f12949b17f9b9405b3ca5953a2c0f023769c99bb06fb245b242', want: 'none' },
  { name: 'a tx that was never broadcast', kind: 'mirror_open', user: 'B', tx: '0x' + 'ab'.repeat(32), want: 'none' },
];

let bad = 0;
for (const [i, c] of cases.entries()) {
  const ref = `case-${i}`;
  recordEngineTx(c.tx, c.user === 'B' ? B : C, c.kind, ref);
  const r = await landed('nadfun', c.kind, ref, c.user);
  const got = r.state === 'filled' ? `filled ${r.sizeRaw}` : r.state;
  const ok = c.want === 'filled' ? r.state === 'filled' : got === c.want;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${c.name}: ${got}${r.state === 'filled' ? ` ($${r.notionalUsd.toFixed(4)}, ${r.txHash})` : ''}`);
}
getDb().close();
if (bad) {
  console.error(`\n${bad} case(s) wrong`);
  process.exit(1);
}
console.log('\nOK: crash recovery reads real Nad.fun fills back from the chain');
