'use client';

import { useEffect, useState } from 'react';
import { Copy, Download, Share2, X } from 'lucide-react';
import { drawPnlCard, roiText, type TradeResult } from '@/lib/pnlCard';
import { dollars, signedDollars } from '@/lib/format';

// Shown right after a close: the PnL card as an image, ready to share,
// copy or save.

type Props = { result: TradeResult; onClose: () => void };

export function PnlCardSheet({ result, onClose }: Props) {
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

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const fileName = `cult-${result.symbol.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${new Date(result.closedAt).toISOString().slice(0, 10)}.png`;
  const file = blob ? new File([blob], fileName, { type: 'image/png' }) : null;
  const canShare = !!file && typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  const canCopy = typeof window !== 'undefined' && 'ClipboardItem' in window && !!navigator.clipboard?.write;
  const roi = roiText(result);
  const up = (result.pnlUsd ?? 0) >= 0;

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

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="dialog pnl-sheet" role="dialog" aria-modal="true" aria-label="Trade closed">
      <button className="icon-btn dialog-close" title="Close" onClick={onClose}><X size={16} /></button>
      <div className="pnl-sheet-head">
        <span className="eyebrow">Trade closed</span>
        <h2>{result.symbol}</h2>
        <p className="field-note">{result.pnlUsd == null ? 'Your position is closed.' : <>You {up ? 'made' : 'lost'} <b className={up ? 'up' : 'down'}>{up ? signedDollars(result.pnlUsd) : dollars(Math.abs(result.pnlUsd))}</b>{roi ? <> ({roi})</> : null}. Here&rsquo;s your card.</>}</p>
      </div>
      <div className="pnl-sheet-card">
        {/* eslint-disable-next-line @next/next/no-img-element -- a generated blob, not a static asset */}
        {url ? <img src={url} alt={`PnL card: ${result.symbol} ${roi ?? ''}`} /> : error ? <p className="notice-line">{error}</p> : <span className="skel" />}
      </div>
      <div className="pnl-sheet-actions">
        {canShare ? <button className="btn btn-primary" disabled={!blob} onClick={() => void share()}><Share2 size={16} /> Share</button>
          : canCopy ? <button className="btn btn-primary" disabled={!blob} onClick={() => void copy()}><Copy size={16} /> Copy image</button> : null}
        <button className="btn btn-ghost" disabled={!url} onClick={save}><Download size={16} /> Save image</button>
      </div>
      {note && <p className="pnl-sheet-note" role="status">{note}</p>}
    </section>
  </div>;
}
