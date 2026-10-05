import { Dashboard } from '@/components/Dashboard';
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID) return <main className="config-state"><div className="brand">CULT<span className="brand-dot">.</span></div><h1>App configuration pending</h1><p>Set the Privy app ID to enable wallet access.</p></main>;
  // A demo link shows the app's splash while demo mode loads, not the landing page.
  const demoHint = (await searchParams).demo === '1';
  return <Dashboard demoHint={demoHint} />;
}
