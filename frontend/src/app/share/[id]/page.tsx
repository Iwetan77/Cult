import { ArrowUpRight, Flame, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getPublicShare } from '@/lib/api';
import { signedDollars, dollars } from '@/lib/format';
import type { PublicShare } from '@/lib/contracts';
import { TokenLogo } from '@/components/TokenLogo';
import { Avatar } from '@/components/Avatar';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const load = (id: string) => getPublicShare(id).catch(() => null);
const roiText = (s: PublicShare) => s.roiPercent == null ? null : `${s.roiPercent > 0 ? '+' : ''}${s.roiPercent.toFixed(1)}%`;
const price = (v: number | null) => v == null ? '—' : dollars(v, v < 1 ? 6 : 2);

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const s = await load((await params).id);
  if (!s) return { title: 'Cult · trade result' };
  const headline = `${s.traderName} ${roiText(s) ?? (s.pnlUsd == null ? '' : signedDollars(s.pnlUsd))} on ${s.marketSymbol}`.replace(/\s+/g, ' ');
  return {
    title: `${headline} · Cult`,
    description: `A ${s.side} on ${s.marketSymbol}, traded on Cult: every trade from the trader's own account, verified on-chain.`,
    openGraph: { title: headline, type: 'website' },
    twitter: { card: 'summary_large_image', title: headline },
  };
}

// The public PnL card. The image people see when the link is posted comes
// from ./opengraph-image.tsx; this is the page the link opens.
export default async function SharePage({ params }: Params) {
  const result = await load((await params).id);
  if (!result) return <main className="pnl-page"><div className="pnl-empty"><span className="pnl-brand">CULT<i>.</i></span><h1>Result unavailable</h1><p>This trade result may have expired or been removed.</p><Link className="pnl-open" href="/">Open Cult <ArrowUpRight size={16} /></Link></div></main>;

  const up = (result.pnlUsd ?? result.roiPercent ?? 0) >= 0;
  const roi = roiText(result);
  const rec = result.traderRecord;
  const perp = result.venue === 'perpl';
  const side = result.side === 'buy' ? 'BUY' : result.side.toUpperCase();
  const when = new Date(result.closedAt ?? result.sharedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  return <main className="pnl-page">
    <article className={`pnl-card ${up ? 'up' : 'down'}`}>
      <header className="pnl-top">
        <span className="pnl-brand">CULT<i>.</i></span>
        {rec?.verified ? <span className="pnl-verified"><ShieldCheck size={14} /> Verified on-chain</span> : <span className="pnl-verified muted">{result.closedAt ? 'Closed trade' : 'Open position'}</span>}
      </header>

      <div className="pnl-market">
        <TokenLogo symbol={result.marketSymbol} className="pnl-logo" />
        <div><strong>{result.marketSymbol}</strong><span><b className={`side-chip ${result.side}`}>{side}{perp && result.leverage ? ` ${result.leverage}x` : ''}</b>{perp ? 'Perpetual' : 'Spot'} · {result.closedAt ? 'Closed' : 'Open'}</span></div>
      </div>

      <div className="pnl-figures">
        <div className="pnl-roi">{roi ?? (result.pnlUsd == null ? 'Pending' : signedDollars(result.pnlUsd))}</div>
        {roi && result.pnlUsd != null && <div className="pnl-usd">{signedDollars(result.pnlUsd)}</div>}
      </div>

      <dl className="pnl-prices">
        <div><dt>Entry</dt><dd>{price(result.entryPrice)}</dd></div>
        <div><dt>{result.closedAt ? 'Exit' : 'Mark'}</dt><dd>{price(result.markPrice)}</dd></div>
        <div><dt>{perp ? 'Size' : 'Value'}</dt><dd>{dollars(result.notionalUsd)}</dd></div>
      </dl>

      <footer className="pnl-trader">
        <Avatar name={result.traderName} url={result.traderAvatarUrl} />
        <div>
          <strong>{result.traderName}</strong>
          <small>{rec?.verified ? <>{rec.tradeCount} trades{rec.winRate != null ? ` · ${Math.round(rec.winRate * 100)}% win` : ''}{rec.streak > 1 ? <> · <Flame size={11} /> {rec.streak} in a row</> : ''}</> : when}</small>
        </div>
        {result.includeClan && result.clanName && <span className="pnl-cult">{result.clanName}</span>}
      </footer>
    </article>

    <div className="pnl-cta">
      <p>Trade together on Cult. Every trade from its own account, verified on-chain.</p>
      <Link className="pnl-open" href="/">Open Cult <ArrowUpRight size={16} /></Link>
    </div>
  </main>;
}
