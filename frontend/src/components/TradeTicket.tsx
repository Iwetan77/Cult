'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight } from './icons';
import type { Clan, Me } from '@/lib/contracts';
import { dollars } from '@/lib/format';

// A perps ticket in the terms people bet in: the big number is the money you
// put in; leverage multiplies it into the position size shown under it. So
// "$50 at 10x" is a $500 position, and moving leverage never changes your
// stake. Flip the unit to type the position size in the asset instead. The
// backend moves wallet funds into the Perpl account when it's short. Pick Long or Short at the top; one
// button places it. Memes: amount and Buy, no leverage.

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
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [postTo, setPostTo] = useState<PostTo>(defaultPostTo);
  useEffect(() => { setPostTo(defaultPostTo); }, [defaultPostTo]);
  useEffect(() => { setAmountText(''); setUnit('usd'); setSide('long'); setLeverage(isPerp ? Math.min(2, maxLev) : 1); }, [market.id, isPerp, maxLev]);

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
  // In $ your stake stays put and the position grows. In the asset the
  // position stays put.
  const changeLeverage = (value: number) => setLeverage(Math.max(1, Math.min(maxLev, Math.round(value))));
  const toggleUnit = () => {
    const next = unit === 'usd' ? 'asset' : 'usd';
    setUnit(next);
    if (stakeUsd > 0) show(stakeUsd, next);
  };
  const cultIds = cults.length === 0 || postTo === 'all' ? undefined : postTo === 'none' ? [] : [postTo];
  const submit = (side: 'long' | 'short' | 'buy') => { if (valid) onSubmit(side, stakeUsd, isPerp ? lev : undefined, cultIds); };
  const assetSize = price > 0 && positionUsd > 0 ? `${trim(positionUsd / price, 6)} ${asset}` : null;

  const quick = isPerp ? [10, 50, 100, 500] : [10, 100, 500, 1000];

  return <div className="ticket">
    {isPerp && <div className="seg seg--fill ticket-side" role="radiogroup" aria-label="Side">
      <button type="button" role="radio" aria-checked={side === 'long'} className={side === 'long' ? 'on long' : ''} onClick={() => setSide('long')}>Long</button>
      <button type="button" role="radio" aria-checked={side === 'short'} className={side === 'short' ? 'on short' : ''} onClick={() => setSide('short')}>Short</button>
    </div>}
    <div className="ticket-amount">
      <div className="ticket-row"><label className="ticket-label" htmlFor="ticket-size">{unit === 'usd' ? (isPerp ? 'You put in' : 'Amount') : `${isPerp ? 'Position size' : 'Amount'} in ${asset}`}</label><span className="ticket-avail">Available <b className="num">{available == null ? '—' : dollars(available)}</b></span></div>
      <div className="ticket-input">
        {unit === 'usd' && <span className="ticket-prefix">$</span>}
        <input id="ticket-size" className="num" inputMode="decimal" placeholder="0" value={amountText} onChange={event => { setAmountText(event.target.value.replace(/[^0-9.]/g, '')); }} />
        <button type="button" className="ticket-unit" onClick={toggleUnit} title={`Enter in ${unit === 'usd' ? asset : 'dollars'}`}>{unit === 'usd' ? 'USD' : asset} <ArrowLeftRight size={12} /></button>
      </div>
      <small className="ticket-other">{isPerp
        ? (positionUsd > 0 ? <>Position <b className="num">{dollars(positionUsd)}</b>{assetSize ? ` · ${assetSize}` : ''} at {lev}x{unit === 'asset' ? ` · you put in ${dollars(stakeUsd)}` : ''}</> : `× ${lev} leverage = your position size`)
        : (stakeUsd > 0 ? (unit === 'usd' ? (assetSize ? `≈ ${assetSize}` : '') : `≈ ${dollars(stakeUsd)}`) : `in dollars or ${asset}`)}</small>
      {unit === 'usd' && <div className="ticket-quick">{quick.map(q => <button type="button" key={q} onClick={() => setAmountText(String(q))}>${q}</button>)}</div>}
    </div>

    {isPerp && <div className="ticket-slider">
      <div className="ticket-row"><span className="ticket-label">Leverage</span><strong className="num">{lev}x</strong></div>
      <input type="range" min={1} max={maxLev} step={1} value={lev} onChange={event => changeLeverage(Number(event.target.value))} aria-label="Leverage" style={{ '--fill': `${((lev - 1) / Math.max(1, maxLev - 1)) * 100}%` } as React.CSSProperties} />
      <div className="ticket-ticks">{leverageTicks(maxLev).map(t => <button type="button" key={t} className={t === lev ? 'on' : ''} onClick={() => changeLeverage(t)}>{t}x</button>)}</div>
    </div>}

    <dl className="ticket-summary">
      <div><dt>You put in</dt><dd className="num">{dollars(stakeUsd)}</dd></div>
      {isPerp && <div><dt>Position</dt><dd className="num">{dollars(positionUsd)}</dd></div>}
      {isPerp && <div><dt>Entry ≈</dt><dd className="num">{price > 0 ? dollars(price, price < 1 ? 6 : 2) : '—'}</dd></div>}
    </dl>
    {tooBig && <p className="ticket-warn">More than you have available.{onDeposit && <button type="button" className="link" onClick={onDeposit}>Deposit</button>}</p>}
    {!tooBig && shortInAccount && stakeUsd > 0 && <p className="ticket-note">Funds move from your wallet automatically.</p>}

    {cults.length ? <label className="ticket-post">
      <span className="ticket-label">Post to</span>
      <select value={postTo} onChange={event => setPostTo(event.target.value)}>
        <option value="all">All my cults ({cults.length})</option>
        {cults.map(cult => <option key={cult.id} value={cult.id}>{cult.name}</option>)}
        <option value="none">Only me (private)</option>
      </select>
    </label> : <p className="ticket-note">You&apos;re not in a cult yet, so this trade is yours alone. Join or create one to trade with friends.</p>}

    {isPerp ? <button type="button" className={`ticket-submit ${side}`} disabled={!valid || busy} onClick={() => submit(side)}>{side === 'long' ? 'Long' : 'Short'} {asset}{positionUsd > 0 && <small className="num">{dollars(positionUsd)}</small>}</button>
      : <button type="button" className="ticket-submit long" disabled={!valid || busy} onClick={() => submit('buy')}>Buy {market.symbol}{stakeUsd > 0 && <small className="num">{dollars(stakeUsd)}</small>}</button>}
    {cults.length > 0 && <p className="ticket-foot">{postTo === 'none' ? 'Only you see this trade.' : 'Cult-mates on Auto-follow copy it, sized to their own limits.'}</p>}
  </div>;
}
