'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Link2, Shuffle, Share2, X } from './icons';
import { drawPnlCard, encodePnlGif, prepareCard, roiText, type CardRenderer, type TradeResult } from '@/lib/pnlCard';
import { giphyEnabled, moodOf, pickGif, type GifPick } from '@/lib/giphy';
import { loadGifFrames, type GifFrames } from '@/lib/gifFrames';
import { dollars, signedDollars } from '@/lib/format';

// The PnL card, ready to share, copy or save. With a GIPHY key it carries a
// reaction GIF picked for how the trade went (a new one each time, or tap
// "New GIF") and exports as an animated GIF; otherwise it's a still PNG.
// Three moments:
// - closed: right after a close or a sale.
// - live: sharing a position you keep open (from the chart).
// - confirm: before a close, the card you'd get at the current mark, with
//   Keep open / Close position. Dashboard swaps it to "closed" once it fills.

export type PnlSheetMode = 'closed' | 'live' | 'confirm';

type Props = {
  result: TradeResult; mode?: PnlSheetMode; busy?: boolean;
  confirmLabel?: string; onConfirm?: () => void;
  // Before a close: how much of the position to close (1 = all).
  closeShare?: number; onCloseShare?: (share: number) => void;
  // Real accounts can also share a public link to an open position.
  onShareLink?: () => void;
  onClose: () => void;
};

type Gif = { pick: GifPick; frames: GifFrames };

export function PnlCardSheet({ result, mode = 'closed', busy = false, confirmLabel = 'Close position', onConfirm, closeShare = 1, onCloseShare, onShareLink, onClose }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [renderer, setRenderer] = useState<CardRenderer | null>(null);
  const [gif, setGif] = useState<Gif | null>(null);
  const [gifLoading, setGifLoading] = useState(giphyEnabled());
  const [reroll, setReroll] = useState(0);
  const shown = useRef<string[]>([]);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mood = moodOf(result.roiPct, result.pnlUsd);
  const exporting = mode !== 'confirm';

  // A GIF for this mood: a new pick when the mood changes or on "New GIF";
  // the same one carries over from the close preview to the final card.
  useEffect(() => {
    if (!giphyEnabled()) return;
    let active = true;
    setGifLoading(true); setNote(null);
    pickGif(mood, shown.current).then(async pick => {
      if (!pick) throw new Error('No GIF this time.');
      const frames = await loadGifFrames(pick.url);
      if (!active) return;
      shown.current = [...shown.current, pick.id];
      setGif({ pick, frames });
    }).catch(() => { if (active) setNote(current => current ?? 'Couldn’t load a GIF, so this card is a still image.'); })
      .finally(() => { if (active) setGifLoading(false); });
    return () => { active = false; };
  }, [mood, reroll]);

  // The card itself, for the preview: redrawn only when the numbers change
  // (the parent hands over a fresh but identical result every second while a
  // close waits for confirmation), and the old card stays up until the new one
  // is ready, so it never blinks.
  const resultKey = JSON.stringify(result);
  const latestResult = useRef(result);
  latestResult.current = result;
  useEffect(() => {
    let active = true;
    prepareCard(latestResult.current, 0.8).then(card => { if (active) setRenderer(card); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Could not draw the card.'); });
    return () => { active = false; };
  }, [resultKey]);

  // Play the preview: each GIF frame in the window, at its own pace.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !renderer) return;
    el.width = renderer.width; el.height = renderer.height;
    const ctx = el.getContext('2d')!;
    const art = (i: number) => gif ? { source: gif.frames.frames[i]!.image, width: gif.frames.width, height: gif.frames.height } : null;
    renderer.draw(ctx, art(0));
    if (!gif || gif.frames.frames.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0, timer = 0;
    const next = () => {
      timer = window.setTimeout(() => { frame = (frame + 1) % gif.frames.frames.length; renderer.draw(ctx, art(frame)); next(); }, gif.frames.frames[frame]!.delay);
    };
    next();
    return () => window.clearTimeout(timer);
  }, [renderer, gif]);

  // The file to share: made ahead of the tap, since sharing has to start
  // right from it. An animated GIF when there is one, else a PNG.
  useEffect(() => {
    // A new GIF on the way: the old file must not be shared meanwhile.
    if (gifLoading) { setBlob(null); return; }
    if (!exporting) return;
    let active = true;
    setBlob(null); setProgress(gif ? 0 : null);
    (gif ? encodePnlGif(result, gif.frames, done => { if (active) setProgress(done); }) : drawPnlCard(result))
      .then(made => { if (active) { setBlob(made); setProgress(null); } })
      .catch(reason => { if (active) { setProgress(null); setError(reason instanceof Error ? reason.message : 'Could not make the card.'); } });
    return () => { active = false; };
  }, [exporting, gifLoading, gif, result]);
  useEffect(() => { setNote(null); }, [mode]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, busy]);

  const animated = blob?.type === 'image/gif';
  const fileName = `cult-${result.symbol.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48)}-${new Date(result.closedAt).toISOString().slice(0, 10)}.${animated ? 'gif' : 'png'}`;
  const file = useMemo(() => blob ? new File([blob], fileName, { type: blob.type }) : null, [blob, fileName]);
  const canShare = !!file && typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  // Clipboards take PNGs, not GIFs: Copy is only for the still card.
  const canCopy = !!blob && !animated && typeof window !== 'undefined' && 'ClipboardItem' in window && !!navigator.clipboard?.write;
  const roi = roiText(result);
  const up = (result.pnlUsd ?? 0) >= 0;
  const amount = result.pnlUsd == null ? null : <b className={up ? 'up' : 'down'}>{up ? signedDollars(result.pnlUsd) : dollars(Math.abs(result.pnlUsd))}</b>;

  const share = async () => {
    if (!file) return;
    try { await navigator.share({ files: [file], title: `${result.symbol} on Cult` }); }
    catch (reason) { if (!(reason instanceof DOMException && reason.name === 'AbortError')) setNote(`Sharing didn’t work here. Save the ${animated ? 'GIF' : 'image'} instead.`); }
  };
  const copy = async () => {
    if (!blob) return;
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); setNote('Card copied. Paste it anywhere.'); }
    catch { setNote('Couldn’t copy here. Save the image instead.'); }
  };
  const save = () => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = fileName;
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setNote('Saved to your downloads.');
  };

  const eyebrow = mode === 'confirm' ? 'Before you close' : mode === 'live' ? 'Open position' : 'Trade closed';
  const title = result.prediction ? result.prediction.title : result.symbol;
  // A prediction is sold, not closed.
  const verb = result.prediction ? 'Sell' : 'Close';
  const line = mode === 'confirm'
    ? (amount ? <>{result.prediction ? 'Selling' : 'Closing'} now locks in {up ? 'a profit of' : 'a loss of'} {amount}{roi ? <> ({roi})</> : null} at the {result.prediction ? 'current price' : 'current mark'}. The final fill can differ slightly.</> : `${verb} this position at the current market price?`)
    : mode === 'live'
      ? (amount ? <>You&rsquo;re {up ? 'up' : 'down'} {amount}{roi ? <> ({roi})</> : null} right now. Share your card.</> : 'Share your position as it stands.')
      : (amount ? <>You {up ? 'made' : 'lost'} {amount}{roi ? <> ({roi})</> : null}. Here&rsquo;s your card.</> : 'Your position is closed.');
  const making = progress != null ? `Making your GIF… ${Math.round(progress * 100)}%` : null;
  const kind = animated ? 'GIF' : 'image';

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className={`dialog pnl-sheet is-${mode}`} role="dialog" aria-modal="true" aria-label={mode === 'confirm' ? `${verb} ${title}?` : eyebrow}>
      <button className="icon-btn dialog-close" title="Close" disabled={busy} onClick={onClose}><X size={16} /></button>
      <div className="pnl-sheet-head">
        <h2 className={result.prediction ? 'is-long' : undefined}>{mode === 'confirm' ? `${verb} ${title}?` : title}</h2>
        <p className="field-note">{line}</p>
      </div>
      <div className={`pnl-sheet-card${renderer ? '' : ' is-loading'}`}>
        <canvas ref={canvas} aria-label={`PnL card: ${result.symbol} ${roi ?? ''}`} role="img" />
        {!renderer && (error ? <p className="notice-line">{error}</p> : <span className="skel" />)}
        {renderer && gifLoading && <span className="pnl-sheet-gifwait">Finding a GIF…</span>}
      </div>
      {giphyEnabled() && <div className="pnl-sheet-gifbar">
        <button className="btn btn-ghost btn-sm" disabled={gifLoading || busy || progress != null} onClick={() => setReroll(value => value + 1)}><Shuffle size={14} /> New GIF</button>
      </div>}
      {mode === 'confirm' && onCloseShare && <div className="seg seg--fill pnl-sheet-share" role="radiogroup" aria-label="How much to close">
        {[0.25, 0.5, 0.75, 1].map(share => <button key={share} type="button" role="radio" aria-checked={closeShare === share} className={closeShare === share ? 'on' : ''} disabled={busy} onClick={() => onCloseShare(share)}>{share === 1 ? 'All' : `${share * 100}%`}</button>)}
      </div>}
      {mode === 'confirm' ? <div className="pnl-sheet-actions" key="confirm">
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Keep open</button>
        <button className="btn btn-danger" disabled={busy} onClick={onConfirm}>{busy ? (result.prediction ? 'Selling…' : 'Closing…') : confirmLabel}</button>
      </div> : <div className="pnl-sheet-actions" key="share">
        {!blob ? <button className="btn btn-primary" disabled>{making ?? 'Preparing…'}</button>
          : canShare ? <button className="btn btn-primary" onClick={() => void share()}><Share2 size={16} /> Share {kind}</button>
            : canCopy ? <button className="btn btn-primary" onClick={() => void copy()}><Copy size={16} /> Copy image</button>
              : <button className="btn btn-primary" onClick={save}><Download size={16} /> Save {kind}</button>}
        {(canShare || canCopy) && <button className="btn btn-ghost" onClick={save}><Download size={16} /> Save</button>}
        {mode === 'live' && onShareLink && <button className="btn btn-ghost" disabled={busy} onClick={onShareLink}><Link2 size={16} /> Link</button>}
      </div>}
      {note && <p className="pnl-sheet-note" role="status">{note}</p>}
    </section>
  </div>;
}
