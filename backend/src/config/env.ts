import 'dotenv/config';

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export const env = {
  perplApiUrl: opt('PERPL_API_URL', 'https://testnet.perpl.xyz/api'),
  perplWsUrl: opt('PERPL_WS_URL', 'wss://testnet.perpl.xyz'),
  chainId: Number(opt('PERPL_CHAIN_ID', '10143')),
  exchangeAddress: opt('PERPL_EXCHANGE_ADDRESS', '0x1964C32f0bE608E7D29302AFF5E61268E72080cc'),
  collateralToken: opt('PERPL_COLLATERAL_TOKEN', '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC'),
  rpcUrl: opt('ALCHEMY_MONAD_RPC_URL', 'https://testnet-rpc.monad.xyz'),
};
