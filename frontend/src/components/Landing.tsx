'use client';

import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { X } from './icons';
import './landing.css';

type LoginMethod = 'google' | 'wallet';
type Props = { onLogin: (method: LoginMethod) => void; pendingLogin: LoginMethod | null; onDemo?: () => void };

const A = '/landing';
const DOTS = ['dot-pink', 'dot-yellow', 'dot-blue', 'dot-green'];

// Figma 36:1096, the cult chart card.
const LEADERS = [['23.daddy', '+15.6%'], ['Solstice', '+10.73%'], ['Krdnl', '+10.4%'], ['0xtandid', '+8.3%']] as const;

// Plays once when the card scrolls into view: header in, the chart wipes in left to right (so the
// line and the members' entry dots appear in order), a live ring pulses on the latest price, then the
// results rise in and count up. Same phases and .lp-a classes as the How it works cards.
function ChartPanel() {
  const [ref, phase] = useReveal<HTMLDivElement>();
  return <div ref={ref} className={`lp-panel lp-chart__panel lp-reveal--${phase}`}>
    <div className="lp-chart__col">
      <div className="lp-chart__head">
        <div className="lp-ticker lp-a lp-a--rise" style={{ '--d': '0s' } as CSSProperties}>
          <img className="lp-ticker__icon" src={`${A}/ton.png`} alt="" />
          <span className="lp-ticker__name">TON</span>
          <span className="lp-pill lp-a lp-a--pop" style={{ '--d': '0.35s' } as CSSProperties}>LONG</span>
        </div>
        <p className="lp-chart__caller lp-a lp-a--rise" style={{ '--d': '0.15s' } as CSSProperties}>position called by <strong>23.daddy</strong></p>
      </div>
      <div className="lp-chart__body">
        <div className="lp-chart__graph">
          <img className="lp-a lp-a--wipe" style={{ '--d': '0.3s' } as CSSProperties} src={`${A}/chart-main.svg`} width={473.042} height={206} alt="TON price line with caller entry markers" />
          <span className="lp-chart__live" aria-hidden="true" />
        </div>
        <ul className="lp-leaders lp-a lp-a--rise" style={{ '--d': '0.9s' } as CSSProperties}>
          {LEADERS.map(([who, gain], i) =>
            <li key={who} className="lp-a lp-a--slide" style={{ '--d': `${1 + i * 0.12}s` } as CSSProperties}>
              <span className="lp-leaders__who"><img src={`${A}/${DOTS[i]}.svg`} width={12} height={12} alt="" />{who}</span>
              <span className="lp-gain"><CountUp value={gain} phase={phase} delay={1100 + i * 120} duration={1100} /></span>
            </li>)}
        </ul>
      </div>
    </div>
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
    <div className="lp-markets__stage" data-reveal>
      <h2 className="lp-display lp-display--88"><Words text="Perps, memes, and next-block meta." /></h2>
      <p className="lp-lead lp-lead--dark lp-a lp-a--rise" style={{ '--d': '0.4s' } as CSSProperties}>Scalp MON perps and snipe fresh Nad.fun runners.<br />When the cult spots the rotation, you’re already in position.</p>
      <ul className="lp-markets__cards">
        {MARKET_CARDS.map((card, i) =>
          <li key={card.src} className="lp-markets__card" ref={el => { cardRefs.current[i] = el; }} style={{ '--x': card.x, '--y': card.y, '--size': card.size, '--band': card.band, '--mx': card.mx, '--my': card.my } as CSSProperties}>
            <img src={`${A}/scroll/${card.src}.png`} width={306} height={290} alt={card.alt} />
          </li>)}
      </ul>
    </div>
  </section>;
}

// "How it works" cards (Figma 34:794). Each card plays its intro once when it scrolls into view.
// Phases: 'static' = server render / no JS / reduced motion, everything shown as designed;
// 'armed' = waiting below the fold, animated parts hidden; 'in' = playing.
type RevealPhase = 'static' | 'armed' | 'in';

function useReveal<T extends Element>() {
  const ref = useRef<T>(null);
  const [phase, setPhase] = useState<RevealPhase>('static');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setPhase('armed');
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setPhase('in');
      observer.disconnect();
    }, { threshold: 0.35 });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, phase] as const;
}

// Splits a headline into words that stagger in (.lp-a--word), --step seconds apart from --delay.
// Spaces stay real text and hyphenated words are split after each hyphen ("next-" + "block"), so the
// line can still break wherever the plain string would: wrapping is unchanged.
function Words({ text, delay = 0, step = 0.07 }: { text: string; delay?: number; step?: number }) {
  return <>{text.split(' ').map((word, i) => {
    const style = { '--d': `${(delay + i * step).toFixed(2)}s` } as CSSProperties;
    const parts = word.split('-').map((part, j, all) => j < all.length - 1 ? `${part}-` : part).filter(Boolean);
    return <Fragment key={i}>{i > 0 && ' '}{parts.map((part, j) => <span key={j} className="lp-word lp-a lp-a--word" style={style}>{part}</span>)}</Fragment>;
  })}</>;
}

const motionAllowed = () => typeof IntersectionObserver !== 'undefined' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Page-wide in-view reveals: every [data-reveal] element is armed (its .lp-a parts hidden) and plays
// its intro once a fifth of it is on screen. Classes are added outside React; the elements' own
// className props never change, so React leaves them alone.
function useRevealAll(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !motionAllowed()) return;
    const targets = [...root.querySelectorAll<HTMLElement>('[data-reveal]')];
    targets.forEach(el => el.classList.add('lp-reveal--armed'));
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.replace('lp-reveal--armed', 'lp-reveal--in');
      observer.unobserve(entry.target);
    }), { threshold: 0.2 });
    targets.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [rootRef]);
}

// Scroll-linked effects, as CSS variables: --hero-p (0 -> 1 while scrolling past the hero) and
// --join-p (0 -> 1 while the last section scrolls up into its final position).
function useScrollFx(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !motionAllowed()) return;
    const hero = root.querySelector<HTMLElement>('.lp-hero'), join = root.querySelector<HTMLElement>('.lp-join');
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    let frame = 0;
    const update = () => {
      frame = 0;
      if (hero) {
        const r = hero.getBoundingClientRect();
        hero.style.setProperty('--hero-p', clamp(-r.top / r.height).toFixed(4));
      }
      if (join) {
        const r = join.getBoundingClientRect();
        join.style.setProperty('--join-p', clamp((window.innerHeight - r.top) / r.height).toFixed(4));
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      hero?.style.removeProperty('--hero-p');
      join?.style.removeProperty('--join-p');
    };
  }, [rootRef]);
}

// Counts a value like "$120" or "+1002.64%" up to itself, keeping its prefix, suffix and decimals.
function CountUp({ value, from = 0, phase, delay, duration }: { value: string; from?: number; phase: RevealPhase; delay: number; duration: number }) {
  const [, prefix, digits, suffix] = /^(\D*)([\d.]+)(.*)$/.exec(value) ?? ['', '', '0', ''];
  const target = Number(digits), decimals = digits.split('.')[1]?.length ?? 0;
  const format = (n: number) => `${prefix}${n.toFixed(decimals)}${suffix}`;
  const [current, setCurrent] = useState(from);
  useEffect(() => {
    if (phase !== 'in') return;
    let frame = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      setCurrent(from + (target - from) * easeOut(t));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase, from, target, delay, duration]);
  return <>{phase === 'static' ? value : format(current)}</>;
}

// stagger: seconds this card waits after its neighbours, so a row of cards enters left to right.
function StepCard({ title, text, visualClass = '', stagger = 0, children }: { title: string; text: string; visualClass?: string; stagger?: number; children: (phase: RevealPhase) => ReactNode }) {
  const [ref, phase] = useReveal<HTMLElement>();
  return <article ref={ref} className={`lp-panel lp-step lp-reveal--${phase}`} style={{ '--stagger': `${stagger}s` } as CSSProperties}>
    {/* The frame reserves the visual's scaled size; the visual itself is scaled with a transform. */}
    <div className="lp-step__frame"><div className={`lp-step__visual ${visualClass}`}>{children(phase)}</div></div>
    <div className="lp-step__body">
      <h3 className="lp-a lp-a--rise" style={{ '--d': '0.1s' } as CSSProperties}>{title}</h3>
      <p className="lp-a lp-a--rise" style={{ '--d': '0.2s' } as CSSProperties}>{text}</p>
    </div>
  </article>;
}

const BOARD = [
  { rank: 1, name: '23.daddy', avatar: 'avatar-23daddy', pnl: '+1002.64%' },
  { rank: 2, name: 'Krdnl', avatar: 'avatar-krdnl', pnl: '+900%' },
  { rank: 3, name: 'Solstice', avatar: 'avatar-solstice', pnl: '+857%' },
  { rank: 4, name: '0xtandid', avatar: 'avatar-0xtandid', pnl: '+765.7%' },
] as const;

function RaysVideo() {
  return <video className="lp-rays__video" src={`${A}/light-rail.mp4`} poster={`${A}/rays-bg.png`} autoPlay muted loop playsInline aria-hidden="true" />;
}

// Sign-in sheet: Google or wallet. Opened by the phone nav's Login and the hero's Join / Create a cult
// (both need an account), with copy to match. A native <dialog> gives Escape-to-close,
// focus handling and the top layer; tapping the backdrop closes it. It closes before handing over,
// so Privy's own modal is never underneath it.
type SheetIntent = 'login' | 'join' | 'create';
const SHEET_COPY: Record<SheetIntent, { title: string; text: string }> = {
  login: { title: 'Log in to Cult', text: 'Your wallet, your funds, your trades. Pick how you want to sign in.' },
  join: { title: 'Join a cult', text: 'Sign in to join a public cult or one you have an invite code for. Your wallet, your funds, your trades.' },
  create: { title: 'Create a cult', text: 'Sign in to start your own cult on Monad. Your wallet, your funds, your trades.' },
};

function LoginSheet({ open, intent, onClose, onLogin, onDemo }: { open: boolean; intent: SheetIntent; onClose: () => void; onLogin: (method: LoginMethod) => void; onDemo?: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const firstOption = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) { dialog.showModal(); firstOption.current?.focus(); }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const choose = (method: LoginMethod) => { ref.current?.close(); onLogin(method); };
  return <dialog ref={ref} className="lp-login" aria-labelledby="lp-login-title" onClose={onClose}
    onClick={event => { if (event.target === event.currentTarget) ref.current?.close(); }}>
    <div className="lp-login__panel">
      <button type="button" className="lp-login__close" aria-label="Close" onClick={() => ref.current?.close()}><X size={18} /></button>
      <img className="lp-login__logo" src={`${A}/cult-logo.svg`} width={65.399} height={34.3401} alt="" />
      <h2 id="lp-login-title" className="lp-login__title">{SHEET_COPY[intent].title}</h2>
      <p className="lp-login__text">{SHEET_COPY[intent].text}</p>
      <div className="lp-login__options">
        <button ref={firstOption} type="button" className="lp-btn lp-btn--primary" onClick={() => choose('google')}>Continue with google</button>
        <button type="button" className="lp-btn lp-btn--ghost" onClick={() => choose('wallet')}>Connect wallet</button>
        {onDemo && <button type="button" className="lp-login__demo" onClick={() => { ref.current?.close(); onDemo(); }}>Explore the demo, no sign-in</button>}
      </div>
    </div>
  </dialog>;
}

export function Landing({ onLogin, pendingLogin, onDemo }: Props) {
  const spinner = (method: LoginMethod) => pendingLogin === method && <span className="button-spinner" aria-hidden="true" />;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetIntent, setSheetIntent] = useState<SheetIntent>('login');
  const openSheet = (intent: SheetIntent) => { setSheetIntent(intent); setSheetOpen(true); };
  const rootRef = useRef<HTMLDivElement>(null);
  useRevealAll(rootRef);
  useScrollFx(rootRef);
  const d = (seconds: number) => ({ '--d': `${seconds}s` }) as CSSProperties;
  return <div className="lp" ref={rootRef}>
    {/* Hero plays on page load (pure CSS, see .lp-hero .lp-a), then drifts away as you scroll. */}
    <header className="lp-hero lp-rays">
      <RaysVideo />
      <nav className="lp-nav lp-a lp-a--drop" style={d(0.1)}>
        <a href="#" className="lp-nav__logo" aria-label="Cult home"><img src={`${A}/cult-logo.svg`} width={65.399} height={34.3401} alt="Cult" /></a>
        <div className="lp-nav__actions">
          {/* Wide screens: both ways in. Phones: one Login button that opens the sign-in sheet. */}
          <button type="button" className="lp-btn lp-btn--primary lp-btn--fixed lp-nav__wide" onClick={() => onLogin('google')}>Login {spinner('google')}</button>
          <button type="button" className="lp-btn lp-btn--ghost lp-btn--fixed lp-nav__wide" onClick={() => onLogin('wallet')}>Connect wallet {spinner('wallet')}</button>
          <button type="button" className="lp-btn lp-btn--primary lp-nav__narrow" aria-haspopup="dialog" onClick={() => openSheet('login')}>
            Login {pendingLogin && <span className="button-spinner" aria-hidden="true" />}
          </button>
        </div>
      </nav>
      <div className="lp-hero__body">
        <h1 className="lp-hero__title"><Words text="Trade together. Own every move" delay={0.3} step={0.09} /></h1>
        <div className="lp-hero__ctas">
          <button type="button" className="lp-btn lp-btn--primary lp-a lp-a--pop" style={d(0.85)} aria-haspopup="dialog" onClick={() => openSheet('join')}>Join a cult</button>
          <button type="button" className="lp-btn lp-btn--glass lp-a lp-a--pop" style={d(0.95)} aria-haspopup="dialog" onClick={() => openSheet('create')}>Create a cult</button>
        </div>
      </div>
    </header>

    <section className="lp-section lp-section--dark">
      <div className="lp-chart__split">
        <div className="lp-chart__copy" data-reveal>
          <h2 className="lp-display lp-display--80"><Words text="Every position on one live chart" /></h2>
          <p className="lp-lead lp-a lp-a--rise" style={d(0.4)}>See what the whole cult holds right now, on Perpl and Nad.fun, without switching tabs.</p>
          <a href="#how" className="lp-btn lp-btn--primary lp-btn--fixed lp-a lp-a--pop" style={d(0.55)}>Explore</a>
        </div>
        <ChartPanel />
      </div>
    </section>

    <MarketsScroll />

    <section className="lp-section lp-section--dark lp-how" id="how">
      <h2 className="lp-display lp-display--88 lp-how__title" data-reveal><Words text="From hunch to position, together." /></h2>
      <div className="lp-steps">
        <StepCard title="Post the call" text="Drop a long, a short, or a Nad.fun launch you like. Price, sentiment and funding sit right next to it." visualClass="lp-step__visual--call">
          {phase => <>
            <div className="lp-price lp-a lp-a--rise" style={{ '--d': '0s' } as CSSProperties}>
              <img className="lp-price__icon" src={`${A}/ton.png`} alt="" />
              <div><p className="lp-price__sym">$TON</p><p className="lp-price__amt"><CountUp value="$120" from={96} phase={phase} delay={250} duration={1100} /></p></div>
            </div>
            <img className="lp-price__graph lp-a lp-a--wipe" style={{ '--d': '0.25s' } as CSSProperties} src={`${A}/chart-card.svg`} width={285} height={144} alt="" />
            <div className="lp-step__buttons" aria-hidden="true">
              <span className="lp-btn lp-btn--long lp-a lp-a--pop" style={{ '--d': '0.9s' } as CSSProperties}>Long/Up</span>
              <span className="lp-btn lp-btn--short lp-a lp-a--pop" style={{ '--d': '1s' } as CSSProperties}>Short/Down</span>
            </div>
          </>}
        </StepCard>

        <StepCard stagger={0.12} title="Talk it through" text="Your cult sees the call the moment it lands and argues it out in real time. Nobody trades blind.">
          {() => <div className="lp-chat" aria-hidden="true">
            <div className="lp-msg lp-a lp-a--msg" style={{ left: 0, top: 0, '--d': '0.15s' } as CSSProperties}>
              <img src={`${A}/avatar-23daddy-chat.png`} width={22.711} height={22.711} alt="" />
              <div className="lp-bubble"><b>23.daddy</b><span style={{ width: 148 }}>Found this really cool perps that we can ape in.</span></div>
            </div>
            <div className="lp-msg lp-msg--right lp-a lp-a--msg" style={{ left: 87, top: 51, '--d': '0.75s' } as CSSProperties}>
              <div className="lp-bubble"><b>Krdnl</b><span style={{ width: 149 }}>Drop lets analyse and see when we can enter</span></div>
              <img src={`${A}/avatar-krdnl-chat.png`} width={22.711} height={22.711} alt="" />
            </div>
            <div className="lp-msg lp-msg--top lp-a lp-a--msg" style={{ left: 0, top: 102, '--d': '1.35s' } as CSSProperties}>
              <img src={`${A}/avatar-23daddy-chat.png`} width={22.711} height={22.711} alt="" />
              <div className="lp-bubble lp-bubble--call">
                <b>23.daddy <i>called a new perp play</i></b>
                <div className="lp-mini">
                  <div className="lp-mini__ticker"><img src={`${A}/ton.png`} alt="" /><span>TON</span><em>LONG</em></div>
                  <img className="lp-mini__graph lp-a lp-a--wipe" style={{ '--d': '1.65s' } as CSSProperties} src={`${A}/chart-mini.svg`} width={123.856} height={38.184} alt="" />
                  <span className="lp-mini__join">Join</span>
                </div>
              </div>
            </div>
            <div className="lp-msg lp-msg--right lp-a lp-a--msg" style={{ left: 184, top: 241.11, '--d': '2.15s' } as CSSProperties}>
              <div className="lp-bubble"><b>Oxtandid</b><span>LFGGGGGG!!!!!!!</span></div>
              <img src={`${A}/avatar-oxtandid-chat.png`} width={22.711} height={22.711} alt="" />
            </div>
          </div>}
        </StepCard>

        <StepCard stagger={0.24} title="Trade and keep score" text="Each member executes from their own wallet. P&L updates live and every call is saved to a profile, so the sharpest traders get followed.">
          {phase => <ol className="lp-board">
            {BOARD.map((row, i) => <li key={row.name} className="lp-a lp-a--slide" style={{ '--d': `${0.1 + i * 0.15}s` } as CSSProperties}>
              <span className="lp-board__who">
                {row.rank === 1 ? <span className="lp-medal lp-medal--gold lp-a lp-a--medal" style={{ '--d': '0.45s' } as CSSProperties}><img src={`${A}/star.svg`} width={12.6808} height={12.0601} alt="" /></span>
                  : row.rank === 2 ? <span className="lp-medal lp-medal--silver">2</span>
                  : row.rank === 3 ? <span className="lp-medal lp-medal--bronze">3</span>
                  : <span className="lp-board__rank">4</span>}
                <img src={`${A}/${row.avatar}.png`} width={30} height={30} alt="" />{row.name}
              </span>
              <span className="lp-board__pnl"><CountUp value={row.pnl} phase={phase} delay={490 + i * 150} duration={1200} /></span>
            </li>)}
          </ol>}
        </StepCard>
      </div>
    </section>

    <section className="lp-section lp-section--dark lp-partners" data-reveal>
      <h2 className="lp-display lp-display--88"><Words text="Built on the best in the arena" /></h2>
      <div className="lp-partners__logos">
        <div className="lp-partners__row">
          <img className="lp-a lp-a--rise" style={d(0.45)} src={`${A}/logo-perpl.svg`} width={209.373} height={57.41} alt="Perpl" />
          <img className="lp-a lp-a--rise" style={d(0.57)} src={`${A}/logo-nadfun.svg`} width={257.543} height={57.3293} alt="Nad.fun" />
        </div>
        <img className="lp-a lp-a--rise" style={d(0.69)} src={`${A}/logo-aurora.svg`} width={502.237} height={57.3293} alt="Aurora Intents" />
      </div>
    </section>

    {/* Figma 59:104 (FOOTER). The CULT word rises into place as the section scrolls up (--join-p). */}
    <section className="lp-rays lp-join" id="join" data-reveal>
      <RaysVideo />
      <p className="lp-join__word" aria-hidden="true">CULT</p>
      <div className="lp-join__inner">
        <div className="lp-join__text">
          <h2 className="lp-join__title"><Words text="Get in the cult" step={0.09} /></h2>
          <p className="lp-join__lead lp-a lp-a--rise" style={d(0.4)}>Your wallet, your funds, your trades. Pick a cult or start your own on Monad.</p>
        </div>
        <div className="lp-join__ctas">
          <button type="button" className="lp-btn lp-btn--primary lp-a lp-a--pop" style={d(0.55)} onClick={() => onLogin('google')}>Continue with google {spinner('google')}</button>
          <button type="button" className="lp-btn lp-btn--ghost lp-a lp-a--pop" style={d(0.65)} onClick={() => onLogin('wallet')}>Connect wallet {spinner('wallet')}</button>
        </div>
      </div>
      <footer className="lp-footer">
        <img className="lp-a lp-a--rise" style={d(0.8)} src={`${A}/cult-logo.svg`} width={65.399} height={34.3401} alt="Cult" />
        <p className="lp-a lp-a--rise" style={d(0.9)}>© 2026 CULT. All rights reserved.</p>
      </footer>
    </section>

    <LoginSheet open={sheetOpen} intent={sheetIntent} onClose={() => setSheetOpen(false)} onLogin={onLogin} onDemo={onDemo} />
  </div>;
}
