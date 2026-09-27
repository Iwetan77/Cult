// Sweep every saved throwaway e2e wallet's leftover MON/AUSD back to the funder.
import { ethers } from 'ethers';
import { rpc } from '../../src/chain/signer.js';
import { funder, savedThrowaways, sweepBack } from './fund.js';

const f = funder();
console.log('funder before', ethers.formatEther(await rpc().getBalance(f.address)), 'MON');
for (const s of savedThrowaways()) {
  const r = await sweepBack(s).catch((e) => ({ error: String(e) }));
  console.log(s.address, JSON.stringify(r));
}
console.log('funder after ', ethers.formatEther(await rpc().getBalance(f.address)), 'MON');
