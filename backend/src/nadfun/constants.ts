import { env } from '../config/env.js';

// Nad.fun v2, from Naddotfun/nadfun-v2-intergration (README "aggregator metadata")
// and verified on-chain. Router routes pre-graduation buys/sells to the bonding
// curve and post-graduation ones to the DEX pair, so it's the only contract we call.
const TESTNET = {
  router: '0x75588668999cA0557b78046b8a5E86b47b9234ec',
  bondingCurve: '0x27063a38eC0D3281D354090EB92e669Ed1eB956C',
  factory: '0x59C51c66B79c68F63d5446940CD13b6968788e36',
  wmon: '0x5a4E0bFDeF88C9032CB4d24338C5EB3d3870BfDd',
  apiUrl: 'https://dev-api.nadapp.net',
  deployBlock: 30418615,
};
const MAINNET = {
  router: '0x8986C8fD44eb85294A725a7e61AF35E76bA26F91',
  bondingCurve: '0x9f3832732923252A21044F21eE6bd87F09514ae4',
  factory: '0xA25b13127e63ddae6d0b35570FF3D39dBD621001',
  wmon: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
  apiUrl: 'https://api.nad.fun',
  deployBlock: 73857231,
};

export const NADFUN = env.chainId === 143 ? MAINNET : TESTNET;
