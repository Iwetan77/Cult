'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import type { Clan, Me } from '@/lib/contracts';
import { dollars } from '@/lib/format';

// A perps ticket in the terms people bet in: the big number is the money you
// put in; leverage multiplies it into the position size shown under it. So
// "$50 at 10x" is a $500 position, and moving leverage never changes your
// stake. Flip the unit to type the position size in the asset instead. The
// "% of available" slider fills your stake. The backend moves wallet funds
// into the Perpl account when it's short. Memes: amount and Buy, no leverage.

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
  const [amountText, setAmountText] = useState('');
  const [leverage, setLeverage] = useState(isPerp ? Math.min(2, maxLev) : 1);
  const [pct, setPct] = useState<number | null>(null);
  const [postTo, setPostTo] = useState<PostTo>(defaultPostTo);
  useEffect(() => { setPostTo(defaultPostTo); }, [defaultPostTo]);
  useEffect(() => { setAmountText(''); setPct(null); setUnit('usd'); setLeverage(isPerp ? Math.min(2, maxLev) : 1); }, [market.id, isPerp, maxLev]);

  // What this trade can draw on, in $ of stake.
  const available = useMemo(() => {
    if (!balances) return null;
    const px = monPriceUsd ?? 0;
    const spareMon = Math.max(0, balances.mon - balances.gasReserveMon - (isPerp ? TOPUP_GAS_MON : 0));
    if (isPerp) return (balances.perplMarginUsd ?? 0) + balances.walletUsd + spareMon * px * 0.97;
    const monUsd = spareMon * px;
    return balances.memesPayWith === 'ausd' ? Math.max(balances.walletUsd, monUsd) : monUsd;
  }, [balances, monPriceUsd, isPerp]);

  const lev = isPerp ? leverage : 1;
  const typed = Number(amountText);
  const entered = amountText && Number.isFinite(typed) ? typed : 0;
  // USD: you type your stake. Asset: you type the position size in the asset.
  const stakeUsd = unit === 'usd' ? entered : (entered * price) / lev;
  const positionUsd = stakeUsd * lev;
  const tooBig = available != null && stakeUsd > available * 1.001;
  const valid = stakeUsd >= 1 && !tooBig && (unit === 'usd' || price > 0);
  const shortInAccount = isPerp && balances != null && stakeUsd > (balances.perplMarginUsd ?? 0);

  const show = (stake: number, inUnit = unit, withLev = lev) =>
    setAmountText(stake <= 0 ? '' : inUnit === 'usd' ? trim(stake, 2) : price > 0 ? trim((stake * withLev) / price, 6) : '');
  const fillPct = (p: number) => {
    setPct(p);
    if (available != null) show(available * p / 100);
  };
  const changeLeverage = (value: number) => {
    const next = Math.max(1, Math.min(maxLev, Math.round(value)));
    setLeverage(next);
    // In $ your stake stays put and the position grows. In the asset the
    // position stays put, unless a % is set, which fixes the stake.
    if (unit === 'asset' && pct != null && available != null) show(available * pct / 100, 'asset', next);
  };
  const toggleUnit = () => {
    const next = unit === 'usd' ? 'asset' : 'usd';
    setUnit(next);
    if (stakeUsd > 0) show(stakeUsd, next);
  };
  const cultIds = cults.length === 0 || postTo === 'all' ? undefined : postTo === 'none' ? [] : [postTo];
  const submit = (side: 'long' | 'short' | 'buy') => { if (valid) onSubmit(side, stakeUsd, isPerp ? lev : undefined, cultIds); };
  const assetSize = price > 0 && positionUsd > 0 ? `${trim(positionUsd / price, 6)} ${asset}` : null;

  return <div className="ticket">
    <div className="ticket-size">
      <label className="ticket-label" htmlFor="ticket-size">{unit === 'usd' ? (isPerp ? 'You put in' : 'Amount') : `${isPerp ? 'Position size' : 'Amount'} in ${asset}`}</label>
      <div className="ticket-size-row">
        {unit === 'usd' && <span className="ticket-prefix">$</span>}
        <input id="ticket-size" inputMode="decimal" placeholder="0" value={amountText} onChange={event => { setAmountText(event.target.value.replace(/[^0-9.]/g, '')); setPct(null); }} />
        <button type="button" className="ticket-unit" onClick={toggleUnit} title={`Enter in ${unit === 'usd' ? asset : 'dollars'}`}>{unit === 'usd' ? 'USD' : asset} <ArrowLeftRight size={13} /></button>
      </div>
      <small className="ticket-other">{isPerp
        ? (positionUsd > 0 ? <>Position <b>{dollars(positionUsd)}</b>{assetSize ? ` · ${assetSize}` : ''} at {lev}x{unit === 'asset' ? ` · you put in ${dollars(stakeUsd)}` : ''}</> : `× ${lev} leverage = your position size`)
        : (stakeUsd > 0 ? (unit === 'usd' ? (assetSize ? `≈ ${assetSize}` : '') : `≈ ${dollars(stakeUsd)}`) : `in dollars or ${asset}`)}</small>
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
      <dt>You put in</dt><dd>{dollars(stakeUsd)}</dd>
      {isPerp && <><dt>Position</dt><dd>{dollars(positionUsd)}</dd></>}
      <dt>Available</dt><dd>{available == null ? '—' : dollars(available)}</dd>
      {isPerp && <><dt>Entry ≈</dt><dd>{price > 0 ? dollars(price, price < 1 ? 6 : 2) : '—'}</dd></>}
    </dl>
    {tooBig && <p className="ticket-warn">More than you have available.{onDeposit && <button type="button" className="text-link" onClick={onDeposit}>Deposit</button>}</p>}
    {!tooBig && shortInAccount && stakeUsd > 0 && <p className="ticket-note">Funds move from your wallet automatically.</p>}

    {cults.length ? <label className="ticket-post">
      <span className="ticket-label">Post to</span>
      <select value={postTo} onChange={event => setPostTo(event.target.value)}>
        <option value="all">All my cults ({cults.length})</option>
        {cults.map(cult => <option key={cult.id} value={cult.id}>{cult.name}</option>)}
        <option value="none">Only me (private)</option>
      </select>
    </label> : <p className="ticket-note">You&apos;re not in a cult yet, so this trade is yours alone. Join or create one to trade with friends.</p>}

    {isPerp ? <div className="ticket-actions">
      <button type="button" className="ticket-long" disabled={!valid || busy} onClick={() => submit('long')}>Long<small>{positionUsd > 0 ? dollars(positionUsd) : asset}</small></button>
      <button type="button" className="ticket-short" disabled={!valid || busy} onClick={() => submit('short')}>Short<small>{positionUsd > 0 ? dollars(positionUsd) : asset}</small></button>
    </div> : <button type="button" className="ticket-long ticket-buy" disabled={!valid || busy} onClick={() => submit('buy')}>Buy {market.symbol}<small>{stakeUsd > 0 ? dollars(stakeUsd) : ''}</small></button>}
    {cults.length > 0 && <p className="ticket-foot">{postTo === 'none' ? 'Only you see this trade.' : 'Cult-mates on Auto-follow copy it, sized to their own limits.'}</p>}
  </div>;
}
