'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import type { Clan, Me } from '@/lib/contracts';
import { dollars } from '@/lib/format';

// A standard perps ticket. You type the position size (in $ or in the asset),
// pick leverage on a slider, or fill the size from a "% of available" slider.
// Margin = size / leverage; the backend moves wallet funds into the Perpl
// account when it's short. Memes: size in $ (or tokens), no leverage, Buy only.

export type PostTo = 'all' | 'none' | string; // a cult id
export type TicketMarket = { venue: 'perpl' | 'nadfun'; id: string; symbol: string; maxLeverage: number; priceUsd: number | null };

type Props = {
  market: TicketMarket;
  balances: Me['balances'];
  monPriceUsd: number | null;
  cults: Clan[];
  defaultPostTo: PostTo;
  busy: boolean;
  onSubmit: (side: 'long' | 'short' | 'buy', marginUsd: number, leverage: number | undefined, cultIds: string[] | undefined) => void;
  onDeposit?: () => void;
};

const TOPUP_GAS_MON = 0.1; // kept for the swap + deposit, on top of the reserve (matches the backend)

// Round leverage stops that fit the market, always ending at its max.
function leverageTicks(max: number): number[] {
  const stops = [1, 2, 3, 5, 10, 20, 25, 50, 100].filter(x => x < max);
  const ticks = [...stops, max];
  return ticks.length > 6 ? [ticks[0]!, ...ticks.slice(-5)] : ticks;
}

const assetOf = (symbol: string) => symbol.replace(/-PERP$/i, '').replace(/^\$/, '');
const trim = (value: number, digits: number) => String(Number(value.toFixed(digits)));

export function TradeTicket({ market, balances, monPriceUsd, cults, defaultPostTo, busy, onSubmit, onDeposit }: Props) {
  const isPerp = market.venue === 'perpl';
  const maxLev = Math.max(1, Math.floor(market.maxLeverage));
  const asset = assetOf(market.symbol);
  const price = market.priceUsd ?? 0;
  const [unit, setUnit] = useState<'usd' | 'asset'>('usd');
  const [sizeText, setSizeText] = useState('');
  const [leverage, setLeverage] = useState(isPerp ? Math.min(2, maxLev) : 1);
  const [pct, setPct] = useState<number | null>(null);
  const [postTo, setPostTo] = useState<PostTo>(defaultPostTo);
  useEffect(() => { setPostTo(defaultPostTo); }, [defaultPostTo]);
  useEffect(() => { setSizeText(''); setPct(null); setLeverage(isPerp ? Math.min(2, maxLev) : 1); }, [market.id, isPerp, maxLev]);

  // What this trade can draw on, in $ of margin.
  const available = useMemo(() => {
    if (!balances) return null;
    const px = monPriceUsd ?? 0;
    const spareMon = Math.max(0, balances.mon - balances.gasReserveMon - (isPerp ? TOPUP_GAS_MON : 0));
    if (isPerp) return (balances.perplMarginUsd ?? 0) + balances.walletUsd + spareMon * px * 0.97;
    const monUsd = spareMon * px;
    return balances.memesPayWith === 'ausd' ? Math.max(balances.walletUsd, monUsd) : monUsd;
  }, [balances, monPriceUsd, isPerp]);

  const lev = isPerp ? leverage : 1;
  const typed = Number(sizeText);
  const sizeUsd = !sizeText || !Number.isFinite(typed) ? 0 : unit === 'usd' ? typed : typed * price;
  const marginUsd = sizeUsd / lev;
  const tooBig = available != null && marginUsd > available * 1.001;
  const valid = marginUsd >= 1 && !tooBig && (unit === 'usd' || price > 0);
  const shortInAccount = isPerp && balances != null && marginUsd > (balances.perplMarginUsd ?? 0);

  const setFromUsd = (usd: number, inUnit = unit) => setSizeText(usd <= 0 ? '' : inUnit === 'usd' ? trim(usd, 2) : price > 0 ? trim(usd / price, 6) : '');
  const fillPct = (p: number, withLev = lev) => {
    setPct(p);
    if (available != null) setFromUsd((available * p / 100) * withLev);
  };
  const changeLeverage = (value: number) => {
    const next = Math.max(1, Math.min(maxLev, Math.round(value)));
    setLeverage(next);
    if (pct != null) fillPct(pct, next);
  };
  const toggleUnit = () => {
    const next = unit === 'usd' ? 'asset' : 'usd';
    setUnit(next);
    if (sizeUsd > 0) setFromUsd(sizeUsd, next);
  };
  const cultIds = postTo === 'all' ? undefined : postTo === 'none' ? [] : [postTo];
  const submit = (side: 'long' | 'short' | 'buy') => { if (valid) onSubmit(side, marginUsd, isPerp ? lev : undefined, cultIds); };
  const other = unit === 'usd' ? (price > 0 && sizeUsd > 0 ? `≈ ${trim(sizeUsd / price, 6)} ${asset}` : `in ${asset}`) : `≈ ${dollars(sizeUsd)}`;

  return <div className="ticket">
    <div className="ticket-size">
      <label className="ticket-label" htmlFor="ticket-size">{isPerp ? 'Position size' : 'Amount'}</label>
      <div className="ticket-size-row">
        {unit === 'usd' && <span className="ticket-prefix">$</span>}
        <input id="ticket-size" inputMode="decimal" placeholder="0" value={sizeText} onChange={event => { setSizeText(event.target.value.replace(/[^0-9.]/g, '')); setPct(null); }} />
        <button type="button" className="ticket-unit" onClick={toggleUnit} title={`Enter in ${unit === 'usd' ? asset : 'dollars'}`}>{unit === 'usd' ? 'USD' : asset} <ArrowLeftRight size={13} /></button>
      </div>
      <small className="ticket-other">{other}</small>
    </div>

    {isPerp && <div className="ticket-slider">
      <div className="ticket-slider-head"><span className="ticket-label">Leverage</span><strong>{lev}x</strong></div>
      <input type="range" min={1} max={maxLev} step={1} value={lev} onChange={event => changeLeverage(Number(event.target.value))} aria-label="Leverage" style={{ '--fill': `${((lev - 1) / Math.max(1, maxLev - 1)) * 100}%` } as React.CSSProperties} />
      <div className="ticket-ticks">{leverageTicks(maxLev).map(t => <button type="button" key={t} className={t === lev ? 'active' : ''} onClick={() => changeLeverage(t)}>{t}x</button>)}</div>
    </div>}

    <div className="ticket-slider">
      <div className="ticket-slider-head"><span className="ticket-label">% of available</span><strong>{pct == null ? '—' : `${pct}%`}</strong></div>
      <input type="range" min={0} max={100} step={1} value={pct ?? 0} disabled={available == null || available <= 0} onChange={event => fillPct(Number(event.target.value))} aria-label="Percent of available funds" style={{ '--fill': `${pct ?? 0}%` } as React.CSSProperties} />
      <div className="ticket-ticks">{[0, 25, 50, 75, 100].map(t => <button type="button" key={t} className={pct === t ? 'active' : ''} disabled={available == null || available <= 0} onClick={() => fillPct(t)}>{t}%</button>)}</div>
    </div>

    <dl className="ticket-summary">
      {isPerp && <><dt>Margin</dt><dd>{dollars(marginUsd)}</dd></>}
      <dt>Available</dt><dd>{available == null ? '—' : dollars(available)}</dd>
      {isPerp && <><dt>Entry ≈</dt><dd>{price > 0 ? dollars(price, price < 1 ? 6 : 2) : '—'}</dd></>}
    </dl>
    {tooBig && <p className="ticket-warn">More than you have available.{onDeposit && <button type="button" className="text-link" onClick={onDeposit}>Deposit</button>}</p>}
    {!tooBig && shortInAccount && marginUsd > 0 && <p className="ticket-note">Funds move from your wallet automatically.</p>}

    <label className="ticket-post">
      <span className="ticket-label">Post to</span>
      <select value={postTo} onChange={event => setPostTo(event.target.value)}>
        <option value="all">All my cults</option>
        {cults.map(cult => <option key={cult.id} value={cult.id}>{cult.name}</option>)}
        <option value="none">Just me</option>
      </select>
    </label>

    {isPerp ? <div className="ticket-actions">
      <button type="button" className="ticket-long" disabled={!valid || busy} onClick={() => submit('long')}>Long<small>{sizeUsd > 0 ? dollars(sizeUsd) : asset}</small></button>
      <button type="button" className="ticket-short" disabled={!valid || busy} onClick={() => submit('short')}>Short<small>{sizeUsd > 0 ? dollars(sizeUsd) : asset}</small></button>
    </div> : <button type="button" className="ticket-long ticket-buy" disabled={!valid || busy} onClick={() => submit('buy')}>Buy {market.symbol}<small>{sizeUsd > 0 ? dollars(sizeUsd) : ''}</small></button>}
    <p className="ticket-foot">{postTo === 'none' ? 'Only you see this trade.' : `Cult-mates on Auto-follow copy it, sized to their own limits.`}</p>
  </div>;
}
