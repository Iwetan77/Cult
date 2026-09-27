// Perpl request signing, checked against the real servers without an
// account: an unregistered Ed25519 key must be refused as *unauthorised*
// (WS close 3401, REST 401). A malformed sign-in frame would close 1011 and a
// malformed REST signature 400, so this rules out format bugs early.
import '../../src/config/env.js';
import WebSocket from 'ws';
import * as ed from '@noble/ed25519';
import { env } from '../../src/config/env.js';
import { signRestHeaders, wsSignInFrame } from '../../src/perpl/auth.js';

const creds = { apiKey: 'not-a-real-key', secret: ed.utils.randomSecretKey() };
const ws = new WebSocket(`${env.perplWsUrl}/ws/v1/trading`);
ws.on('open', async () => ws.send(JSON.stringify(await wsSignInFrame(creds))));
ws.on('close', (code, reason) => {
  console.log(`trading ws closed: ${code} ${reason.toString()}  (3401 = frame parsed, key refused; 1011 = frame unparseable)`);
});
await new Promise((r) => setTimeout(r, 8000));
const h = await signRestHeaders(creds, 'GET', '/v1/trading/wallet');
const r = await fetch(`${env.perplApiUrl}/v1/trading/wallet`, { headers: h });
console.log(`REST signed GET /v1/trading/wallet with an unregistered key -> ${r.status} ${(await r.text()).slice(0, 120)}`);
process.exit(0);
