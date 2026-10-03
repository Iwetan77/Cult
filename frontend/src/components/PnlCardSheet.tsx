'use client';

import { useEffect, useState } from 'react';
import { Copy, Download, Link2, Share2, X } from 'lucide-react';
import { drawPnlCard, roiText, type TradeResult } from '@/lib/pnlCard';
import { dollars, signedDollars } from '@/lib/format';

// The PnL card as an image, ready to share, copy or save. Three moments:
// - closed: right after a close or a sale.
// - live: sharing a position you keep open (from the chart).
// - confirm: before a close, the card you'd get at the current mark, with
//   Keep open / Close position. Dashboard swaps it to "closed" once it fills.

export type PnlSheetMode = 'closed' | 'live' | 'confirm';

type Props = {
  result: TradeResult; mode?: PnlSheetMode; busy?: boolean;
  confirmLabel?: string; onConfirm?: () => void;
  // Real accounts can also share a public link to an open position.
  onShareLink?: () => void;
  onClose: () => void;
};

export function PnlCardSheet({ result, mode = 'closed', busy = false, confirmLabel = 'Close position', onConfirm, onShareLink, onClose }: Props) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let active = true, made: string | null = null;
    drawPnlCard(result).then(image => {
      if (!active) return;
      made = URL.createObjectURL(image);
      setBlob(image); setUrl(made);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Could not draw the card.'); });
    return () => { active = false; if (made) URL.revokeObjectURL(made); };
  }, [result]);
  useEffect(() => { setNote(null); }, [mode]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, busy]);

  const fileName = `cult-${result.symbol.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48)}-${new Date(result.closedAt).toISOString().slice(0, 10)}.png`;
  const file = blob ? new File([blob], fileName, { type: 'image/png' }) : null;
  const canShare = !!file && typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  const canCopy = typeof window !== 'undefined' && 'ClipboardItem' in window && !!navigator.clipboard?.write;
  const roi = roiText(result);
  const up = (result.pnlUsd ?? 0) >= 0;
  const amount = result.pnlUsd == null ? null : <b className={up ? 'up' : 'down'}>{up ? signedDollars(result.pnlUsd) : dollars(Math.abs(result.pnlUsd))}</b>;

  const share = async () => {
    if (!file) return;
    try { await navigator.share({ files: [file], title: `${result.symbol} on Cult` }); }
    catch (reason) { if (!(reason instanceof DOMException && reason.name === 'AbortError')) setNote('Sharing didn’t work here. Save the image instead.'); }
  };
  const copy = async () => {
    if (!blob) return;
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); setNote('Card copied. Paste it anywhere.'); }
    catch { setNote('Couldn’t copy here. Save the image instead.'); }
  };
  const save = () => {
    if (!url) return;
    const link = document.createElement('a');
    link.href = url; link.download = fileName;
    document.body.appendChild(link); link.click(); link.remove();
    setNote('Saved to your downloads.');
  };

  const eyebrow = mode === 'confirm' ? 'Before you close' : mode === 'live' ? 'Open position' : 'Trade closed';
  const title = result.prediction ? result.prediction.title : result.symbol;
  const line = mode === 'confirm'
    ? (amount ? <>Closing now locks in {up ? 'a profit of' : 'a loss of'} {amount}{roi ? <> ({roi})</> : null} at the current mark. The final fill can differ slightly.</> : 'Close this position at the current market price?')
    : mode === 'live'
      ? (amount ? <>You&rsquo;re {up ? 'up' : 'down'} {amount}{roi ? <> ({roi})</> : null} right now. Share your card.</> : 'Share your position as it stands.')
      : (amount ? <>You {up ? 'made' : 'lost'} {amount}{roi ? <> ({roi})</> : null}. Here&rsquo;s your card.</> : 'Your position is closed.');

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className={`dialog pnl-sheet is-${mode}`} role="dialog" aria-modal="true" aria-label={mode === 'confirm' ? `Close ${title}?` : eyebrow}>
      <button className="icon-btn dialog-close" title="Close" disabled={busy} onClick={onClose}><X size={16} /></button>
      <div className="pnl-sheet-head">
        <span className="eyebrow">{eyebrow}</span>
        <h2 className={result.prediction ? 'is-long' : undefined}>{mode === 'confirm' ? `Close ${title}?` : title}</h2>
        <p className="field-note">{line}</p>
      </div>
      <div className="pnl-sheet-card">
        {/* eslint-disable-next-line @next/next/no-img-element -- a generated blob, not a static asset */}
        {url ? <img src={url} alt={`PnL card: ${result.symbol} ${roi ?? ''}`} /> : error ? <p className="notice-line">{error}</p> : <span className="skel" />}      </div>
      {mode === 'confirm' ? <div className="pnl-sheet-actions" key="confirm">
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Keep open</button>
        <button className="btn btn-danger" disabled={busy} onClick={onConfirm}>{busy ? 'Closing…' : confirmLabel}</button>
      </div> : <div className="pnl-sheet-actions" key="share">
        {canShare ? <button className="btn btn-primary" disabled={!blob} onClick={() => void share()}><Share2 size={16} /> Share</button>
          : canCopy ? <button className="btn btn-primary" disabled={!blob} onClick={() => void copy()}><Copy size={16} /> Copy image</button> : null}
        <button className="btn btn-ghost" disabled={!url} onClick={save}><Download size={16} /> Save image</button>
        {mode === 'live' && onShareLink && <button className="btn btn-ghost" disabled={busy} onClick={onShareLink}><Link2 size={16} /> Link</button>}
      </div>}
      {note && <p className="pnl-sheet-note" role="status">{note}</p>}
    </section>
  </div>;
}
