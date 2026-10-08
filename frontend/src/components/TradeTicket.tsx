'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight } from './icons';
import type { Clan, Me, TpslValues } from '@/lib/contracts';
import { dollars } from '@/lib/format';
import { HIGH_LEVERAGE, liquidationMove, liquidationPrice } from '@/lib/risk';

// A perps ticket in the terms people bet in: the big number is the money you
// put in; leverage multiplies it into the position size shown under it. So
// "$50 at 10x" is a $500 position, and moving leverage never changes your
// stake. Flip the unit to type the position size in the asset instead. The
// backend moves wallet funds into the Perpl account when it's short. Pick Long or Short at the top; one
// button places it. Perps can also set a take profit and stop loss, placed as
// real trigger orders once the trade is open. Memes: amount and Buy, no leverage.

export type PostTo = 'all' | 'none' | string; // a cult id
export type TicketMarket = { venue: 'perpl' | 'nadfun'; id: string; symbol: string; maxLeverage: number; priceUsd: number | null; takerFeeBps?: number | null };

type Props = {
  market: TicketMarket;
  balances: Me['balances'];
  monPriceUsd: number | null;
  cults: Clan[]; // the cults this trade can be shared with (where you're an admin)
  inCults?: boolean; // a member of any cult at all
  defaultPostTo: PostTo;
  busy: boolean;
  onSubmit: (side: 'long' | 'short' | 'buy', marginUsd: number, leverage: number | undefined, cultIds: string[] | undefined, tpsl?: TpslValues) => void;
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

export function TradeTicket({ market, balances, monPriceUsd, cults, inCults = false, defaultPostTo, busy, onSubmit, onDeposit }: Props) {
  const isPerp = market.venue === 'perpl';
  const maxLev = Math.max(1, Math.floor(market.maxLeverage));
  const asset = assetOf(market.symbol);
  const price = market.priceUsd ?? 0;
  const [unit, setUnit] = useState<'usd' | 'asset'>('usd');
  const [amountText, setAmountText] = useState('');
  const [leverage, setLeverage] = useState(isPerp ? Math.min(2, maxLev) : 1);
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [levelsOn, setLevelsOn] = useState(false);
  // Above HIGH_LEVERAGE, the first press asks you to confirm.
  const [confirming, setConfirming] = useState(false);
  const [tpText, setTpText] = useState('');
  const [slText, setSlText] = useState('');
  const [postTo, setPostTo] = useState<PostTo>(defaultPostTo);
  useEffect(() => { setPostTo(defaultPostTo); }, [defaultPostTo]);
  useEffect(() => { setAmountText(''); setUnit('usd'); setSide('long'); setLevelsOn(false); setTpText(''); setSlText(''); setConfirming(false); setLeverage(isPerp ? Math.min(2, maxLev) : 1); }, [market.id, isPerp, maxLev]);

  // What this trade can draw on, in $ of stake.
  const available = useMemo(() => {
    if (!balances) return null;
    const px = monPriceUsd ?? 0;
    const spareMon = Math.max(0, balances.mon - balances.gasReserveMon - (isPerp ? TOPUP_GAS_MON : 0));
    // Deposited USDC counts as dollars: a trade turns it into AUSD when it needs it.
    const dollars = balances.walletUsd + (balances.usdcUsd ?? 0);
    if (isPerp) return (balances.perplMarginUsd ?? 0) + dollars + spareMon * px * 0.97;
    const monUsd = spareMon * px;
    return balances.memesPayWith === 'ausd' ? Math.max(dollars, monUsd) : monUsd;
  }, [balances, monPriceUsd, isPerp]);

  const lev = isPerp ? leverage : 1;
  const typed = Number(amountText);
  const entered = amountText && Number.isFinite(typed) ? typed : 0;
  // USD: you type your stake. Asset: you type the position size in the asset.
  const stakeUsd = unit === 'usd' ? entered : (entered * price) / lev;
  const positionUsd = stakeUsd * lev;
  const tooBig = available != null && stakeUsd > available * 1.001;
  const levels = isPerp && levelsOn;
  const tp = levels && tpText ? Number(tpText) : null;
  const sl = levels && slText ? Number(slText) : null;
  const up = side === 'long';
  const tpProblem = tp == null ? null : !(tp > 0) ? 'Enter a price.' : price > 0 && (up ? tp <= price : tp >= price) ? `Take profit should be ${up ? 'above' : 'below'} the price.` : null;
  const slProblem = sl == null ? null : !(sl > 0) ? 'Enter a price.' : price > 0 && (up ? sl >= price : sl <= price) ? `Stop loss should be ${up ? 'below' : 'above'} the price.` : null;
  const valid = stakeUsd >= 1 && !tooBig && (unit === 'usd' || price > 0) && !tpProblem && !slProblem;
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
  const cultIds = cults.length === 0 || postTo === 'none' ? [] : postTo === 'all' ? undefined : [postTo];
  // Risk, shown before you trade: the taker fee and where you'd be liquidated.
  const feeUsd = isPerp && market.takerFeeBps != null && positionUsd > 0 ? positionUsd * market.takerFeeBps / 10_000 : null;
  const liq = isPerp && price > 0 ? liquidationPrice(price, side, lev, maxLev) : null;
  const liqMove = isPerp ? liquidationMove(lev, maxLev) : null;
  useEffect(() => { setConfirming(false); }, [lev, side]);
  const submit = (side: 'long' | 'short' | 'buy', confirmed = false) => {
    if (!valid) return;
    if (isPerp && lev > HIGH_LEVERAGE && !confirmed) { setConfirming(true); return; }
    setConfirming(false);
    onSubmit(side, stakeUsd, isPerp ? lev : undefined, cultIds, levels && (tp != null || sl != null) ? { ...(tp != null ? { takeProfit: tp } : {}), ...(sl != null ? { stopLoss: sl } : {}) } : undefined);
  };
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

    {isPerp && <div className="ticket-levels">
      <label className="ticket-row ticket-levels-toggle"><span className="ticket-label">Take profit / Stop loss</span><input type="checkbox" className="switch" checked={levelsOn} onChange={event => setLevelsOn(event.target.checked)} /></label>
      {levelsOn && <>
        <div className="marker-card-fields">
          <label className="marker-card-field is-up"><span>TP</span><input className="num" inputMode="decimal" placeholder="None" aria-label="Take profit price" value={tpText} onChange={event => setTpText(event.target.value.replace(/[^0-9.]/g, ''))} /></label>
          <label className="marker-card-field is-down"><span>SL</span><input className="num" inputMode="decimal" placeholder="None" aria-label="Stop loss price" value={slText} onChange={event => setSlText(event.target.value.replace(/[^0-9.]/g, ''))} /></label>
        </div>
        <small className={`ticket-levels-note${tpProblem || slProblem ? ' down' : ''}`}>{tpProblem ?? slProblem ?? `Set as orders on Perpl once your ${side} is open. Leave one empty to skip it.`}</small>
      </>}
    </div>}

    <dl className="ticket-summary">
      <div><dt>You put in</dt><dd className="num">{dollars(stakeUsd)}</dd></div>
      {isPerp && <div><dt>Position</dt><dd className="num">{dollars(positionUsd)}</dd></div>}
      {isPerp && <div><dt>Entry ≈</dt><dd className="num">{price > 0 ? dollars(price, price < 1 ? 6 : 2) : '—'}</dd></div>}
      {isPerp && <div title="An estimate: assumes a maintenance margin of half the initial margin at this market's max leverage."><dt>Liquidation ≈ <span className="ticket-est">est.</span></dt><dd className="num down">{liq == null ? '—' : dollars(liq, liq < 1 ? 6 : 2)}</dd></div>}
      {feeUsd != null && <div><dt>Fee ≈</dt><dd className="num">{dollars(feeUsd)} <span className="ticket-est">{(market.takerFeeBps! / 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%</span></dd></div>}
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
    </label> : <p className="ticket-note">{inCults ? 'Only cult admins share trades, so this one is yours alone.' : <>You&apos;re not in a cult yet, so this trade is yours alone. Join or create one to trade with friends.</>}</p>}

    {isPerp && confirming ? <div className="ticket-confirm" role="alertdialog" aria-label={`Confirm ${lev}x leverage`}>
      <strong>{lev}x is high leverage</strong>
      <p>A {liqMove == null ? 'small' : `${(liqMove * 100).toFixed(liqMove < 0.1 ? 1 : 0)}%`} move against you liquidates this position{liq == null ? '' : ` (around ${dollars(liq, liq < 1 ? 6 : 2)})`}, and you lose the {dollars(stakeUsd)} you put in.</p>
      <div className="ticket-confirm-actions">
        <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
        <button type="button" className={`ticket-submit ${side}`} disabled={!valid || busy} onClick={() => submit(side, true)}>Open {lev}x {side}</button>
      </div>
    </div>
      : isPerp ? <button type="button" className={`ticket-submit ${side}`} disabled={!valid || busy} onClick={() => submit(side)}>{side === 'long' ? 'Long' : 'Short'} {asset}{positionUsd > 0 && <small className="num">{dollars(positionUsd)}</small>}</button>
      : <button type="button" className="ticket-submit long" disabled={!valid || busy} onClick={() => submit('buy')}>Buy {market.symbol}{stakeUsd > 0 && <small className="num">{dollars(stakeUsd)}</small>}</button>}
    {cults.length > 0 && <p className="ticket-foot">{postTo === 'none' ? 'Only you see this trade.' : 'Cult-mates on Auto-follow copy it, sized to their own limits.'}</p>}
  </div>;
}
