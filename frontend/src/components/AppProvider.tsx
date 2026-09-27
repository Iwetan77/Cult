'use client';
import { PrivyProvider } from '@privy-io/react-auth';
import { monad, monadTestnet } from 'viem/chains';

export function AppProvider({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) return <>{children}</>;
  return <PrivyProvider appId={appId} config={{
    loginMethods: ['google', 'wallet'],
    appearance: { theme: 'dark', accentColor: '#68e7be', showWalletLoginFirst: false },
    embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
    supportedChains: [monadTestnet, monad], defaultChain: monadTestnet,
  }}>{children}</PrivyProvider>;
}
