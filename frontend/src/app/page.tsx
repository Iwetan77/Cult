import { Dashboard } from '@/components/Dashboard';
export default function Home() {
  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID) return <main className="config-state"><div className="brand">CULT<span className="brand-dot">.</span></div><h1>App configuration pending</h1><p>Set the Privy app ID to enable wallet access.</p></main>;
  return <Dashboard />;
}
