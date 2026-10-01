'use client';

import { useEffect, useState } from 'react';
import { getMarket, getMarkets } from '@/lib/api';
import type { Candle, MarketListing } from '@/lib/contracts';
import { dollars } from '@/lib/format';
import { logoFor } from '@/lib/logos';
import './landing.css';

type LoginMethod = 'google' | 'wallet';
type Props = { onLogin: (method: LoginMethod) => void; pendingLogin: LoginMethod | null };

const A = '/landing';
const DOTS = ['dot-pink', 'dot-yellow', 'dot-blue', 'dot-green'];

// Live perps for the chart card. Public endpoints, no sign-in needed.
type Live = { featured: MarketListing; candles: Candle[]; movers: MarketListing[] };

function useLiveMarkets() {
  const [live, setLive] = useState<Live | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { markets } = await getMarkets('', 'perpl');
      const priced = markets.filter(m => m.priceUsd != null).sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
      const featured = priced[0];
      if (!featured) return;
      const { candles } = await getMarket(featured.id, 3600);
      if (!cancelled) setLive({ featured, candles: candles.slice(-48), movers: priced.slice(0, 4) });
    };
    // The static design stays up if the backend is unreachable.
    load().catch(() => {});
    const timer = window.setInterval(() => { load().catch(() => {}); }, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  return live;
}

const W = 466, H = 200, PAD = 6;
function LiveGraph({ candles }: { candles: Candle[] }) {
  const closes = candles.map(c => c.close);
  const min = Math.min(...closes), max = Math.max(...closes);
  const span = max - min || 1;
  const pts = closes.map((v, i) => [PAD + (i / Math.max(1, closes.length - 1)) * (W - PAD * 2), PAD + (1 - (v - min) / span) * (H * 0.6)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return <svg className="lp-chart__graph" width={W} height={H} viewBox={`0 0 ${W} ${H}`} fill="none" role="img" aria-label="Last 48 hours of price">
    <defs><linearGradient id="lp-live-fill" x1="0" y1="-100" x2="0" y2={H} gradientUnits="userSpaceOnUse"><stop stopColor="#63F0D6" /><stop offset="1" stopOpacity="0" /></linearGradient></defs>
    <path d={`${line} L${last[0].toFixed(1)} ${H} L${PAD} ${H} Z`} fill="url(#lp-live-fill)" />
    <path d={line} stroke="#63F0D6" strokeWidth="2.08" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx={last[0]} cy={last[1]} r="6" fill="#FF91F4" />
  </svg>;
}

function ChartPanel() {
  const live = useLiveMarkets();
  if (!live || live.candles.length < 2) return <div className="lp-panel lp-chart__panel">
    <div className="lp-chart__head">
      <div className="lp-ticker"><img className="lp-ticker__icon" src={`${A}/ton.png`} alt="" /><span className="lp-ticker__name">TON</span><span className="lp-pill">LONG</span></div>
      <p className="lp-chart__caller">position called by <strong>23.daddy</strong></p>
    </div>
    <img className="lp-chart__graph" src={`${A}/chart-main.svg`} width={473.042} height={206} alt="TON price line with caller entry markers" />
    <ul className="lp-leaders">
      {[['23.daddy', '+15.6%'], ['Solstice', '+10.73%'], ['Krdnl', '+10.4%'], ['0xtandid', '+8.3%']].map(([who, gain], i) =>
        <li key={who}><span className="lp-leaders__who"><img src={`${A}/${DOTS[i]}.svg`} width={12} height={12} alt="" />{who}</span><span className="lp-gain">{gain}</span></li>)}
    </ul>
  </div>;

  const { featured, candles, movers } = live;
  const symbol = featured.symbol.replace(/-PERP$/i, '');
  const logo = logoFor(featured.symbol, featured.imageUri);
  return <div className="lp-panel lp-chart__panel">
    <div className="lp-chart__head">
      <div className="lp-ticker">
        {logo ? <img className="lp-ticker__icon" src={logo} alt="" /> : <span className="lp-ticker__icon lp-ticker__icon--letter">{symbol.slice(0, 1)}</span>}
        <span className="lp-ticker__name">{symbol}</span><span className="lp-pill">LIVE</span>
      </div>
      <p className="lp-chart__caller">on Perpl at <strong>{dollars(featured.priceUsd, (featured.priceUsd ?? 0) < 1 ? 6 : 2)}</strong></p>
    </div>
    <LiveGraph candles={candles} />
    <ul className="lp-leaders">
      {movers.map((m, i) => {
        const pct = m.change24hPct;
        return <li key={m.id}>
          <span className="lp-leaders__who"><img src={`${A}/${DOTS[i % DOTS.length]}.svg`} width={12} height={12} alt="" />{m.symbol}</span>
          <span className={`lp-gain ${pct != null && pct < 0 ? 'lp-gain--down' : ''}`}>{pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`}</span>
        </li>;
      })}
    </ul>
  </div>;
}

function RaysVideo() {
  return <video className="lp-rays__video" src={`${A}/light-rail.mp4`} poster={`${A}/rays-bg.png`} autoPlay muted loop playsInline aria-hidden="true" />;
}

export function Landing({ onLogin, pendingLogin }: Props) {
  const spinner = (method: LoginMethod) => pendingLogin === method && <span className="button-spinner" aria-hidden="true" />;
  return <div className="lp">
    <header className="lp-hero lp-rays">
      <RaysVideo />
      <nav className="lp-nav">
        <a href="#" className="lp-nav__logo" aria-label="Cult home"><img src={`${A}/cult-logo.svg`} width={65.399} height={34.3401} alt="Cult" /></a>
        <div className="lp-nav__actions">
          <button type="button" className="lp-btn lp-btn--primary lp-btn--fixed" onClick={() => onLogin('google')}>Login {spinner('google')}</button>
          <button type="button" className="lp-btn lp-btn--ghost lp-btn--fixed" onClick={() => onLogin('wallet')}>Connect wallet {spinner('wallet')}</button>
        </div>
      </nav>
      <h1 className="lp-hero__title">Trade together. Own every move</h1>
      <a href="#join" className="lp-btn lp-btn--primary lp-btn--fixed lp-hero__cta">Join a cult</a>
    </header>

    <section className="lp-section lp-section--dark">
      <div className="lp-chart__split">
        <div className="lp-chart__copy">
          <h2 className="lp-display lp-display--80">Every position on one live chart</h2>
          <p className="lp-lead">See what the whole cult holds right now, on Perpl and Nad.fun, without switching tabs.</p>
          <a href="#how" className="lp-btn lp-btn--primary lp-btn--fixed">Explore</a>
        </div>
        <ChartPanel />
      </div>
    </section>

    <section className="lp-section lp-markets">
      <h2 className="lp-display lp-display--88">Perps, memes, and next-block meta.</h2>
      <p className="lp-lead lp-lead--dark">Scalp MON perps and snipe fresh Nad.fun runners.<br />When the cult spots the rotation, you’re already in position.</p>
    </section>

    <section className="lp-section lp-section--dark lp-how" id="how">
      <h2 className="lp-display lp-display--88 lp-how__title">From hunch to position, together.</h2>
      <div className="lp-steps">
        <article className="lp-panel lp-step">
          <div className="lp-step__visual lp-step__visual--call">
            <div className="lp-price">
              <img className="lp-price__icon" src={`${A}/ton.png`} alt="" />
              <div><p className="lp-price__sym">$TON</p><p className="lp-price__amt">$120</p></div>
            </div>
            <img className="lp-price__graph" src={`${A}/chart-card.svg`} width={285} height={144} alt="" />
            <div className="lp-step__buttons" aria-hidden="true">
              <span className="lp-btn lp-btn--long">Long/Up</span>
              <span className="lp-btn lp-btn--short">Short/Down</span>
            </div>
          </div>
          <div className="lp-step__body">
            <h3>Post the call</h3>
            <p>Drop a long, a short, or a Nad.fun launch you like. Price, sentiment and funding sit right next to it.</p>
          </div>
        </article>

        <article className="lp-panel lp-step">
          <div className="lp-step__visual">
            <div className="lp-chat" aria-hidden="true">
              <div className="lp-msg" style={{ left: 0, top: 0 }}>
                <img src={`${A}/avatar-sm.svg`} width={22.7111} height={22.7111} alt="" />
                <div className="lp-bubble"><b>23.daddy</b><span style={{ width: 148 }}>Found this really cool perps that we can ape in.</span></div>
              </div>
              <div className="lp-msg lp-msg--right" style={{ left: 87, top: 51 }}>
                <div className="lp-bubble"><b>Krdnl</b><span style={{ width: 149 }}>Drop lets analyse and see when we can enter</span></div>
                <img src={`${A}/avatar-sm.svg`} width={22.7111} height={22.7111} alt="" />
              </div>
              <div className="lp-msg lp-msg--top" style={{ left: 0, top: 102 }}>
                <img src={`${A}/avatar-sm.svg`} width={22.7111} height={22.7111} alt="" />
                <div className="lp-bubble lp-bubble--call">
                  <b>23.daddy <i>called a new perp play</i></b>
                  <div className="lp-mini">
                    <div className="lp-mini__ticker"><img src={`${A}/ton.png`} alt="" /><span>TON</span><em>LONG</em></div>
                    <img className="lp-mini__graph" src={`${A}/chart-mini.svg`} width={123.856} height={38.184} alt="" />
                    <span className="lp-mini__join">Join</span>
                  </div>
                </div>
              </div>
              <div className="lp-msg lp-msg--right" style={{ left: 184, top: 241.11 }}>
                <div className="lp-bubble"><b>Oxtandid</b><span>LFGGGGGG!!!!!!!</span></div>
                <img src={`${A}/avatar-sm.svg`} width={22.7111} height={22.7111} alt="" />
              </div>
            </div>
          </div>
          <div className="lp-step__body">
            <h3>Talk it through</h3>
            <p>Your cult sees the call the moment it lands and argues it out in real time. Nobody trades blind.</p>
          </div>
        </article>

        <article className="lp-panel lp-step">
          <div className="lp-step__visual">
            <ol className="lp-board">
              <li><span className="lp-board__who"><span className="lp-medal lp-medal--gold"><img src={`${A}/star.svg`} width={12.6808} height={12.0601} alt="" /></span><img src={`${A}/avatar.svg`} width={30} height={30} alt="" />23.daddy</span><span className="lp-board__pnl">+1002.64%</span></li>
              <li><span className="lp-board__who"><span className="lp-medal lp-medal--silver">2</span><img src={`${A}/avatar.svg`} width={30} height={30} alt="" />Krdnl</span><span className="lp-board__pnl">+900%</span></li>
              <li><span className="lp-board__who"><span className="lp-medal lp-medal--bronze">3</span><img src={`${A}/avatar.svg`} width={30} height={30} alt="" />Solstice</span><span className="lp-board__pnl">+857%</span></li>
              <li><span className="lp-board__who"><span className="lp-board__rank">4</span><img src={`${A}/avatar.svg`} width={30} height={30} alt="" />0xtandid</span><span className="lp-board__pnl">+765.7%</span></li>
            </ol>
          </div>
          <div className="lp-step__body">
            <h3>Trade and keep score</h3>
            <p>Each member executes from their own wallet. P&amp;L updates live and every call is saved to a profile, so the sharpest traders get followed.</p>
          </div>
        </article>
      </div>
    </section>

    <section className="lp-section lp-section--dark lp-partners">
      <h2 className="lp-display lp-display--88">Built on the best in the arena</h2>
      <div className="lp-partners__logos">
        <div className="lp-partners__row">
          <img src={`${A}/logo-perpl.svg`} width={209.373} height={57.41} alt="Perpl" />
          <img src={`${A}/logo-nadfun.svg`} width={257.543} height={57.3293} alt="Nad.fun" />
        </div>
        <img src={`${A}/logo-aurora.svg`} width={502.237} height={57.3293} alt="Aurora Intents" />
      </div>
    </section>

    <section className="lp-rays lp-join" id="join">
      <RaysVideo />
      <div className="lp-join__inner">
        <h2 className="lp-join__title">Get in the cult</h2>
        <p className="lp-join__lead">Your wallet, your funds, your trades. Pick a cult or start your own on Monad.</p>
        <div className="lp-join__ctas">
          <button type="button" className="lp-btn lp-btn--primary lp-btn--mono" onClick={() => onLogin('google')}>Continue with Google {pendingLogin === 'google' ? spinner('google') : <span className="lp-btn__icon"><img src={`${A}/arrow.svg`} width={10} height={10} alt="" /></span>}</button>
          <button type="button" className="lp-btn lp-btn--ghost lp-btn--mono" onClick={() => onLogin('wallet')}>Connect wallet {spinner('wallet')}</button>
        </div>
        <p className="lp-join__word" aria-hidden="true">CULT</p>
      </div>
      <footer className="lp-footer">
        <img src={`${A}/cult-logo.svg`} width={65.399} height={34.3401} alt="Cult" />
        <p>© 2026 murmo. All rights reserved.</p>
      </footer>
    </section>
  </div>;
}
