'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import './landing.css';

type LoginMethod = 'google' | 'wallet';
type Props = { onLogin: (method: LoginMethod) => void; pendingLogin: LoginMethod | null };

const A = '/landing';
const DOTS = ['dot-pink', 'dot-yellow', 'dot-blue', 'dot-green'];

// Figma 36:1096, the cult chart card.
const LEADERS = [['23.daddy', '+15.6%'], ['Solstice', '+10.73%'], ['Krdnl', '+10.4%'], ['0xtandid', '+8.3%']] as const;

function ChartPanel() {
  return <div className="lp-panel lp-chart__panel">
    <div className="lp-chart__head">
      <div className="lp-ticker"><img className="lp-ticker__icon" src={`${A}/ton.png`} alt="" /><span className="lp-ticker__name">TON</span><span className="lp-pill">LONG</span></div>
      <p className="lp-chart__caller">position called by <strong>23.daddy</strong></p>
    </div>
    <img className="lp-chart__graph" src={`${A}/chart-main.svg`} width={473.042} height={206} alt="TON price line with caller entry markers" />
    <ul className="lp-leaders">
      {LEADERS.map(([who, gain], i) =>
        <li key={who}><span className="lp-leaders__who"><img src={`${A}/${DOTS[i]}.svg`} width={12} height={12} alt="" />{who}</span><span className="lp-gain">{gain}</span></li>)}
    </ul>
  </div>;
}

// Sticky scroll: the section pins for a few screens of scrolling while these cards rise from the
// bottom edge, one after another, and settle in place over the headline. Listed in arrival order.
// Wide screens: x / y place the card within the stage's free space (0 = left/top edge, 1 =
// right/bottom edge) and size is its width in px on a 1440 x 900 screen (the images are 306 x 290,
// drawn at 2x). Up to 900px wide the text fills the middle, so cards settle in a band above it
// (band 0) or below it (band 1): mx / my place them within that band, three per row, two rows each.
const MARKET_CARDS = [
  { src: 'monad', alt: 'Monad', x: 0.825, y: 0.151, size: 180, band: 0, mx: 0.97, my: 0.04 },
  { src: 'btc', alt: 'BTC', x: 0.071, y: 0.203, size: 170, band: 0, mx: 0.03, my: 0.1 },
  { src: 'solana', alt: 'Solana', x: 0.469, y: 0.12, size: 160, band: 0, mx: 0.5, my: 0 },
  { src: 'ethereum', alt: 'Ethereum', x: 0.937, y: 0.447, size: 170, band: 1, mx: 0.97, my: 0.1 },
  { src: 'sports', alt: 'Sports', x: 0.256, y: 0.264, size: 150, band: 0, mx: 0.17, my: 1 },
  { src: 'pump', alt: 'Pump', x: 0.088, y: 0.583, size: 190, band: 1, mx: 0.03, my: 0.06 },
  { src: 'weather', alt: 'Weather', x: 0.667, y: 0.27, size: 150, band: 0, mx: 0.83, my: 0.92 },
  { src: 'polygon', alt: 'Polygon', x: 0.794, y: 0.768, size: 180, band: 1, mx: 0.5, my: 0 },
  { src: 'esports', alt: 'Esports', x: 0.26, y: 0.853, size: 170, band: 1, mx: 0.17, my: 0.94 },
  { src: 'sui', alt: 'Sui', x: 0.953, y: 0.855, size: 160, band: 1, mx: 0.83, my: 1 },
  { src: 'politics', alt: 'Politics', x: 0.488, y: 0.866, size: 170, band: 0, mx: 0.5, my: 0.88 },
  { src: 'near', alt: 'NEAR', x: 0.031, y: 0.923, size: 150, band: 1, mx: 0.5, my: 0.88 },
] as const;

// Share of the pinned scroll before the first card moves, between card starts, and per card trip.
// The last card lands at 0.04 + 11 * 0.065 + 0.18 = 0.935, leaving a short hold before it unpins.
const LEAD_IN = 0.04, STAGGER = 0.065, TRIP = 0.18;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

function MarketsScroll() {
  const trackRef = useRef<HTMLElement>(null);
  const cardRefs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;

    const update = () => {
      frame = 0;
      const cards = cardRefs.current;
      if (reduced.matches) { cards.forEach(card => card?.style.removeProperty('transform')); return; }
      const rect = track.getBoundingClientRect();
      const stage = (track.firstElementChild as HTMLElement | null)?.offsetHeight ?? window.innerHeight;
      const pinned = rect.height - stage; // scroll distance while the stage is stuck
      const progress = pinned > 0 ? Math.min(1, Math.max(0, -rect.top / pinned)) : 1;
      cards.forEach((card, i) => {
        if (!card) return;
        const t = Math.min(1, Math.max(0, (progress - LEAD_IN - i * STAGGER) / TRIP));
        // Starts one stage height below its resting spot (out of view), ends at rest.
        card.style.transform = `translate3d(0, ${((1 - easeOut(t)) * stage).toFixed(1)}px, 0)`;
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };

    // Where the headline + lead sit in the stage, for the narrow-screen bands above and below them.
    // Re-measured whenever the text box changes size (wrapping, font load, resize).
    const stageEl = track.firstElementChild as HTMLElement | null;
    const title = stageEl?.querySelector('h2'), lead = stageEl?.querySelector('p');
    const measure = () => {
      if (!stageEl || !title || !lead) return;
      stageEl.style.setProperty('--text-top', `${title.offsetTop}px`);
      stageEl.style.setProperty('--text-bottom', `${lead.offsetTop + lead.offsetHeight}px`);
    };
    const textObserver = new ResizeObserver(measure);
    if (stageEl) textObserver.observe(stageEl);
    if (title) textObserver.observe(title);
    if (lead) textObserver.observe(lead);

    const onResize = () => { measure(); schedule(); };

    measure();
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', onResize);
    reduced.addEventListener('change', schedule);
    return () => {
      cancelAnimationFrame(frame);
      textObserver.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', onResize);
      reduced.removeEventListener('change', schedule);
    };
  }, []);

  return <section className="lp-section lp-markets" ref={trackRef}>
    <div className="lp-markets__stage">
      <h2 className="lp-display lp-display--88">Perps, memes, and next-block meta.</h2>
      <p className="lp-lead lp-lead--dark">Scalp MON perps and snipe fresh Nad.fun runners.<br />When the cult spots the rotation, you’re already in position.</p>
      <ul className="lp-markets__cards">
        {MARKET_CARDS.map((card, i) =>
          <li key={card.src} className="lp-markets__card" ref={el => { cardRefs.current[i] = el; }} style={{ '--x': card.x, '--y': card.y, '--size': card.size, '--band': card.band, '--mx': card.mx, '--my': card.my } as CSSProperties}>
            <img src={`${A}/scroll/${card.src}.png`} width={306} height={290} alt={card.alt} />
          </li>)}
      </ul>
    </div>
  </section>;
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
      <div className="lp-hero__body">
        <h1 className="lp-hero__title">Trade together. Own every move</h1>
        <a href="#join" className="lp-btn lp-btn--primary lp-btn--fixed">Join a cult</a>
      </div>
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

    <MarketsScroll />

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

    {/* Figma 59:104 (FOOTER) */}
    <section className="lp-rays lp-join" id="join">
      <RaysVideo />
      <p className="lp-join__word" aria-hidden="true">CULT</p>
      <div className="lp-join__inner">
        <div className="lp-join__text">
          <h2 className="lp-join__title">Get in the cult</h2>
          <p className="lp-join__lead">Your wallet, your funds, your trades. Pick a cult or start your own on Monad.</p>
        </div>
        <div className="lp-join__ctas">
          <button type="button" className="lp-btn lp-btn--primary" onClick={() => onLogin('google')}>Continue with google {pendingLogin === 'google' ? spinner('google') : <span className="lp-btn__icon"><img src={`${A}/arrow.svg`} width={10} height={10} alt="" /></span>}</button>
          <button type="button" className="lp-btn lp-btn--ghost" onClick={() => onLogin('wallet')}>Connect wallet {spinner('wallet')}</button>
        </div>
      </div>
      <footer className="lp-footer">
        <img src={`${A}/cult-logo.svg`} width={65.399} height={34.3401} alt="Cult" />
        <p>© 2026 murmo. All rights reserved.</p>
      </footer>
    </section>
  </div>;
}
