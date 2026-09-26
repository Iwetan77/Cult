import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { getPublicShare } from '@/lib/api';
import { signedUsd, usd } from '@/lib/format';
import type { PublicShare } from '@/lib/contracts';

export const dynamic = 'force-dynamic';

export default async function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let result: PublicShare | null = null;
  try { result = await getPublicShare(id); } catch { /* A share may be revoked or the API may be unavailable. */ }
  if (!result) return <main className="public-share unavailable"><div className="brand">CULT<span className="brand-dot">.</span></div><div><p className="eyebrow">PUBLIC RESULT</p><h1>Result unavailable</h1><p>This trade result may have expired or been removed.</p></div><Link href="/">Open Cult <ArrowUpRight size={16} /></Link></main>;
  return <main className="public-share"><div className="share-top"><div className="brand">CULT<span className="brand-dot">.</span></div><span>VERIFIED TRADE RESULT</span></div><article className="result-card"><div className="result-head"><span className="result-venue">{result.venue === 'perpl' ? 'PERPL' : 'NAD.FUN'}</span><ShieldCheck size={19} /></div><div className="result-identity"><span>{result.traderName}</span><strong>{result.marketSymbol}</strong>{result.includeClan && result.clanName && <small>{result.clanName}</small>}</div><div className={`result-value ${result.pnlUsd >= 0 ? 'positive' : 'negative'}`}>{signedUsd(result.pnlUsd)}</div><div className="result-bottom"><span>{result.closedAt ? new Date(result.closedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Verified track record'}</span><span>{result.roiPercent == null ? usd(result.notionalUsd) : `${result.roiPercent > 0 ? '+' : ''}${result.roiPercent.toFixed(1)}%`}</span></div></article><div className="share-bottom"><span>EVERY TRADE, THEIR OWN ACCOUNT.</span><Link href="/">Open Cult <ArrowUpRight size={16} /></Link></div></main>;
}
