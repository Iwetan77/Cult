import { ImageResponse } from 'next/og';
import { getPublicShare } from '@/lib/api';

// The picture that shows when a PnL card link is posted (X, WhatsApp,
// Telegram...): the result, big, with the market, side and trader.

export const alt = 'A trade result on Cult';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const usd = (v: number) => `${v < 0 ? '-' : v > 0 ? '+' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plain = (v: number | null) => v == null ? '—' : `$${v.toLocaleString('en-US', { minimumFractionDigits: v < 1 ? 4 : 2, maximumFractionDigits: v < 1 ? 6 : 2 })}`;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const s = await getPublicShare((await params).id).catch(() => null);
  const up = (s?.pnlUsd ?? s?.roiPercent ?? 0) >= 0;
  const accent = up ? '#68e7be' : '#e4777d';
  const roi = s?.roiPercent == null ? null : `${s.roiPercent > 0 ? '+' : ''}${s.roiPercent.toFixed(1)}%`;
  const headline = !s ? 'Trade result' : roi ?? (s.pnlUsd == null ? 'Open' : usd(s.pnlUsd));
  const side = !s ? '' : `${s.side === 'buy' ? 'BUY' : s.side.toUpperCase()}${s.venue === 'perpl' && s.leverage ? ` ${s.leverage}x` : ''}`;
  const rec = s?.traderRecord;

  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '56px 64px', background: `radial-gradient(circle at 85% 20%, ${up ? '#1f4a3d' : '#4a2328'} 0%, #16191f 55%)`, color: '#edf1f1', fontFamily: 'sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', fontSize: 40, fontWeight: 800 }}>CULT<span style={{ color: '#68e7be' }}>.</span></div>
        <div style={{ display: 'flex', fontSize: 24, color: rec?.verified ? '#68e7be' : '#8d96a3', border: `2px solid ${rec?.verified ? '#3f6a5d' : '#3a424e'}`, borderRadius: 999, padding: '8px 20px' }}>{rec?.verified ? 'Verified on-chain' : s?.closedAt ? 'Closed trade' : 'Open position'}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', fontSize: 44, fontWeight: 700 }}>
          {s?.marketSymbol ?? ''}
          {side && <span style={{ marginLeft: 22, fontSize: 26, color: s?.side === 'short' ? '#ff9aa1' : '#68e7be', background: s?.side === 'short' ? '#3a2529' : '#1f3a31', borderRadius: 10, padding: '6px 14px' }}>{side}</span>}
        </div>
        <div style={{ display: 'flex', fontSize: 150, fontWeight: 800, color: accent, lineHeight: 1, marginTop: 14 }}>{headline}</div>
        {roi && s?.pnlUsd != null && <div style={{ display: 'flex', fontSize: 44, color: accent, marginTop: 10 }}>{usd(s.pnlUsd)}</div>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 32, fontWeight: 700 }}>{s?.traderName ?? ''}{s?.includeClan && s.clanName ? <span style={{ marginLeft: 16, color: '#8d96a3', fontWeight: 400 }}>· {s.clanName}</span> : null}</div>
          <div style={{ display: 'flex', fontSize: 24, color: '#8d96a3', marginTop: 6 }}>{rec?.verified ? `${rec.tradeCount} trades${rec.winRate != null ? ` · ${Math.round(rec.winRate * 100)}% win rate` : ''}` : 'Trade together on Cult'}</div>
        </div>
        {s && <div style={{ display: 'flex', fontSize: 24, color: '#aeb8c0' }}>{`Entry ${plain(s.entryPrice)}  →  ${s.closedAt ? 'Exit' : 'Now'} ${plain(s.markPrice)}`}</div>}
      </div>
    </div>,
    size,
  );
}
