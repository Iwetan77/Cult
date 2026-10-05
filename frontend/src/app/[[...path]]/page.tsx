import { notFound } from 'next/navigation';
import { Dashboard } from '@/components/Dashboard';
import { parseRoute } from '@/lib/routes';

// Every app page (/, /markets, /settings, ...) is this one page: the dashboard
// reads the URL itself and moves between pages without reloading.
type Props = { params: Promise<{ path?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function App({ params, searchParams }: Props) {
  const { path = [] } = await params;
  if (!parseRoute(`/${path.join('/')}`)) notFound();
  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID) return <main className="config-state"><img className="brand" src="/landing/cult-logo.svg" alt="Cult" width={65} height={34} /><h1>App configuration pending</h1><p>Set the Privy app ID to enable wallet access.</p></main>;
  // A demo link shows the app's splash while demo mode loads, not the landing page.
  const demoHint = (await searchParams).demo === '1';
  return <Dashboard demoHint={demoHint} />;
}
