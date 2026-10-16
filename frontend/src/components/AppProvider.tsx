'use client';
import { PrivyProvider } from '@privy-io/react-auth';
import { monad, monadTestnet } from 'viem/chains';
import { privySupported } from '@/lib/privySupport';
import { currentNetwork } from '@/lib/network';

export function AppProvider({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  // The selected network's chain (Settings > Network); both stay supported.
  const defaultChain = currentNetwork() === 'mainnet' ? monad : monadTestnet;
  if (!appId || !privySupported()) return <>{children}</>;
  return <PrivyProvider appId={appId} config={{
    loginMethods: ['google', 'wallet'],
    appearance: { theme: 'dark', accentColor: '#9333ea', showWalletLoginFirst: false },
    embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
    supportedChains: [monadTestnet, monad], defaultChain,
  }}>{children}</PrivyProvider>;
}
