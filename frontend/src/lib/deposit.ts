import type { DepositInfo } from './contracts';

export function depositInstruction(info: Pick<DepositInfo, 'network' | 'tokens'>): string {
  const symbols = [...new Set(info.tokens.filter(token => token.depositSupported !== false).map(token => token.symbol))];
  const supported = symbols.length < 2 ? symbols[0] : `${symbols.slice(0, -1).join(', ')} or ${symbols.at(-1)}`;
  return supported ? `Send ${supported} on ${info.network.name} to this address.` : 'Deposit options are unavailable. Do not send tokens yet.';
}

export const testnetDepositWarning = 'Testnet USDC is shown in your wallet, but cannot be converted or used for trades here. It is excluded from your dollar total. Use MON for gas and supported meme buys, or Perpl testnet AUSD for perps. Do not send mainnet funds to this testnet deposit.';
