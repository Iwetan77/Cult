'use client';

import { useEffect, useState } from 'react';
import { ArrowRight } from './icons';
import { getMarket } from '@/lib/api';
import { cachedMarket } from '@/lib/marketCache';
import type { MarketDetail } from '@/lib/contracts';
import { price, signedPct } from '@/lib/format';
import { TokenLogo } from './TokenLogo';

// A market chart someone sent to the cult (a message whose markerId is
// "chart:<marketId>"): the market as it is now, its last 48 hours as a line,
// and a way into the full chart.

export const CHART_SHARE = 'chart:';
export const sharedChartOf = (markerId: string | null | undefined) => markerId?.startsWith(CHART_SHARE) ? markerId.slice(CHART_SHARE.length) : null;
export const chartShareBody = (symbol: string) => `shared the ${symbol} chart`;

const HOUR = 3600;

export function ChartShareCard({ marketId, onOpen }: { marketId: string; onOpen: (marketId: string) => void }) {
  const [detail, setDetail] = useState<MarketDetail | null>(() => cachedMarket(marketId, HOUR));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    getMarket(marketId, HOUR).then(d => { if (active) setDetail(d); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [marketId]);

  const m = detail?.market;
  const closes = (detail?.candles ?? []).slice(-48).map(c => c.close);
  const low = Math.min(...closes), high = Math.max(...closes);
  const span = high - low || 1;
  const points = closes.map((value, i) => `${(i / Math.max(1, closes.length - 1)) * 100},${36 - ((value - low) / span) * 32 - 2}`).join(' ');
  const change = m?.change24hPct ?? (closes.length > 1 ? ((closes.at(-1)! - closes[0]!) / closes[0]!) * 100 : null);
  const open = (event: React.MouseEvent) => { event.stopPropagation(); onOpen(marketId); };

  return <div className="chart-share">
    <div className="chart-share-head">
      <TokenLogo symbol={m?.symbol ?? marketId} imageUri={m?.imageUri} />
      <span className="chart-share-name"><strong>{m?.symbol ?? marketId}</strong><small>{m ? (m.venue === 'perpl' ? 'Perpl · 48H chart' : 'Nad.fun · 48H chart') : failed ? 'Chart unavailable' : 'Loading chart…'}</small></span>
      {m && <span className="chart-share-price"><b className="num">{price(m.priceUsd ?? closes.at(-1))}</b><small className={`num ${(change ?? 0) >= 0 ? 'up' : 'down'}`}>{signedPct(change)}</small></span>}
    </div>
    {closes.length > 1 ? <svg className="chart-share-line" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,36 ${points} 100,36`} />
      <polyline points={points} vectorEffect="non-scaling-stroke" />
    </svg> : <span className={`chart-share-line chart-share-line--empty${failed ? '' : ' skel'}`} />}
    <button type="button" className="btn btn-ghost btn-sm chart-share-open" onClick={open}>Open chart <ArrowRight size={14} /></button>
  </div>;
}
