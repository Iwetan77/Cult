import type { Fill, Holding, PredictionSale, TradeSide, Venue } from './contracts';
import { cents } from './polymarket';
import { dollars, signedDollars } from './format';
import { logoFor } from './logos';

// The PnL card shown after you close a trade, drawn on a canvas so it can be
// saved or shared as an image. Built in the app from the position as it was
// just before closing and the closing fill (the public share links only
// cover open positions).

export type TradeResult = {
  symbol: string; venue: Venue; side: TradeSide; leverage: number | null;
  entryPrice: number | null; exitPrice: number | null; sizeUsd: number | null;
  pnlUsd: number | null; roiPct: number | null; closedAt: number;
  traderName: string; traderAvatarUrl: string | null;
  // Set for a prediction-market sale: prices are 0..1 and shown in cents.
  prediction?: { title: string; sideLabel: string; yes: boolean; shares: number };
};

export function resultOfSale(sale: PredictionSale, trader: { name: string; avatarUrl: string | null }): TradeResult {
  const p = sale.position;
  const title = p.outcomeLabel === p.question ? p.question : `${p.outcomeLabel} · ${p.eventTitle}`;
  return {
    symbol: title, venue: 'nadfun', side: 'buy', leverage: null,
    entryPrice: p.avgPrice, exitPrice: sale.price, sizeUsd: sale.proceedsUsd,
    pnlUsd: sale.pnlUsd, roiPct: p.costUsd > 0 ? (sale.pnlUsd / p.costUsd) * 100 : null, closedAt: Date.now(),
    traderName: trader.name, traderAvatarUrl: trader.avatarUrl,
    prediction: { title, sideLabel: p.sideLabel, yes: p.side === 'yes', shares: p.shares },
  };
}

export function resultOfClose(holding: Holding, fill: Fill | null, trader: { name: string; avatarUrl: string | null }): TradeResult {
  const perp = holding.venue === 'perpl';
  const entry = holding.entryPriceAusd;
  const exit = fill && fill.priceAusd > 0 ? fill.priceAusd : holding.markPriceAusd;
  const leverage = perp ? Math.max(1, holding.leverage || 1) : 1;
  // Realized at the exit price when we know the entry; otherwise the venue's
  // own figure (Nad.fun has no entry price, so a meme sale shows its value).
  const realized = entry != null && holding.size > 0 ? (holding.side === 'short' ? -1 : 1) * (exit - entry) * holding.size : null;
  const pnl = realized ?? holding.pnlAusd;
  const cost = entry != null && holding.size > 0 ? (entry * holding.size) / leverage : null;
  return {
    symbol: holding.symbol, venue: holding.venue, side: holding.side, leverage: perp ? leverage : null,
    entryPrice: entry, exitPrice: exit, sizeUsd: holding.valueAusd,
    pnlUsd: pnl, roiPct: pnl != null && cost ? (pnl / cost) * 100 : null, closedAt: Date.now(),
    traderName: trader.name, traderAvatarUrl: trader.avatarUrl,
  };
}

export const roiText = (r: TradeResult) => r.roiPct == null ? null : `${r.roiPct > 0 ? '+' : ''}${r.roiPct.toFixed(1)}%`;
const priceText = (v: number | null) => v == null ? '—' : dollars(v, v < 1 ? 6 : 2);

const W = 1080, H = 1350, PAD = 84;
const MINT = '#63f0d6', RED = '#ff6b6b', INK = '#071b17', TEXT = '#f4f6f8', DIM = 'rgba(244, 246, 248, 0.55)';

// next/font gives the faces generated names; read them off the page.
const family = (variable: string, fallback: string) => {
  const value = typeof document === 'undefined' ? '' : getComputedStyle(document.body).getPropertyValue(variable).trim();
  return value || fallback;
};

// Only same-origin images: anything else would taint the canvas and block export.
const loadImage = (src: string | null) => new Promise<HTMLImageElement | null>(resolve => {
  if (!src || !(src.startsWith('/') || src.startsWith('data:'))) return resolve(null);
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, opts: { bg: string; color: string; stroke?: string; font: string; align?: 'left' | 'right' }) {
  ctx.font = opts.font;
  const w = ctx.measureText(text).width + 48, h = 56;
  const left = opts.align === 'right' ? x - w : x;
  roundRect(ctx, left, y, w, h, h / 2);
  ctx.fillStyle = opts.bg; ctx.fill();
  if (opts.stroke) { ctx.strokeStyle = opts.stroke; ctx.lineWidth = 2; ctx.stroke(); }
  ctx.fillStyle = opts.color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText(text, left + 24, y + h / 2 + 2);
  return w;
}

function circleImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, initials: string, x: number, y: number, size: number, body: string) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); ctx.closePath();
  if (img) { ctx.clip(); ctx.drawImage(img, x, y, size, size); }
  else {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)'; ctx.fill();
    ctx.fillStyle = TEXT; ctx.font = `500 ${Math.round(size * 0.36)}px ${body}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(initials, x + size / 2, y + size / 2 + 2);
  }
  ctx.restore();
}

export async function drawPnlCard(r: TradeResult): Promise<Blob> {
  const display = family('--font-insidia', 'Impact, sans-serif');
  const body = family('--font-aeonik', 'system-ui, sans-serif');
  await Promise.all([document.fonts.load(`400 200px ${display}`), document.fonts.load(`500 40px ${body}`), document.fonts.load(`700 40px ${body}`)]).catch(() => undefined);
  const [rays, logo, token, avatar] = await Promise.all([loadImage('/landing/rays-bg.png'), loadImage('/landing/cult-logo.svg'), loadImage(logoFor(r.symbol)), loadImage(r.traderAvatarUrl)]);

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const up = (r.pnlUsd ?? 0) >= 0;
  const accent = up ? MINT : RED;

  // Background: black, the landing's rays fading in from the top, an accent glow.
  ctx.fillStyle = '#070808'; ctx.fillRect(0, 0, W, H);
  if (rays) { ctx.globalAlpha = up ? 0.5 : 0.28; ctx.drawImage(rays, -120, -260, W + 240, (W + 240) * rays.height / rays.width); ctx.globalAlpha = 1; }
  const fade = ctx.createLinearGradient(0, 0, 0, 760);
  fade.addColorStop(0, 'rgba(7, 8, 8, 0.15)'); fade.addColorStop(1, '#070808');
  ctx.fillStyle = fade; ctx.fillRect(0, 0, W, 760);
  const glow = ctx.createRadialGradient(W * 0.82, 640, 0, W * 0.82, 640, 620);
  glow.addColorStop(0, up ? 'rgba(99, 240, 214, 0.20)' : 'rgba(255, 107, 107, 0.20)'); glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  // Top: logo, "Closed trade".
  if (logo) ctx.drawImage(logo, PAD, 96, 150, 150 * (logo.height / logo.width || 30 / 58));
  else { ctx.fillStyle = TEXT; ctx.font = `400 64px ${display}`; ctx.textBaseline = 'top'; ctx.fillText('CULT', PAD, 96); }
  pill(ctx, 'CLOSED TRADE', W - PAD, 100, { bg: 'rgba(7, 8, 8, 0.55)', color: TEXT, stroke: 'rgba(255, 255, 255, 0.22)', font: `700 24px ${body}`, align: 'right' });

  // Market.
  const marketY = 330;
  const pred = r.prediction;
  circleImage(ctx, pred ? null : token, pred ? (pred.yes ? 'Y' : 'N') : r.symbol.replace(/^\$/, '').slice(0, 1).toUpperCase(), PAD, marketY, 104, body);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  let titleLines = [r.symbol];
  if (pred) {
    // The question, wrapped to two lines.
    ctx.fillStyle = TEXT; ctx.font = `500 46px ${body}`;
    const maxW = W - PAD * 2 - 132, words = pred.title.split(/\s+/), lines: string[] = [''];
    for (const word of words) {
      const next = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${word}` : word;
      if (ctx.measureText(next).width <= maxW || !lines[lines.length - 1]) lines[lines.length - 1] = next;
      else if (lines.length < 2) lines.push(word);
      else { let last = lines[1]!; while (ctx.measureText(`${last}…`).width > maxW && last.length > 1) last = last.slice(0, -1); lines[1] = `${last}…`; break; }
    }
    titleLines = lines;
    lines.forEach((line, i) => ctx.fillText(line, PAD + 132, marketY + 44 + i * 56));
  } else {
    ctx.fillStyle = TEXT; ctx.font = `500 62px ${body}`;
    ctx.fillText(r.symbol, PAD + 132, marketY + 50);
  }
  const chipY = marketY + 66 + (titleLines.length - 1) * 56;
  const side = pred ? pred.sideLabel.toUpperCase() : r.side === 'buy' ? 'BUY' : `${r.side.toUpperCase()}${r.leverage ? ` ${r.leverage}X` : ''}`;
  const shortSide = pred ? !pred.yes : r.side === 'short';
  const sideBg = shortSide ? RED : MINT, sideInk = shortSide ? '#2a0707' : INK;
  const chipW = pill(ctx, side, PAD + 132, chipY, { bg: sideBg, color: sideInk, font: `700 24px ${body}` });
  ctx.fillStyle = DIM; ctx.font = `400 28px ${body}`; ctx.textBaseline = 'middle';
  ctx.fillText(pred ? 'Prediction · Polymarket' : r.venue === 'perpl' ? 'Perpetual' : 'Meme', PAD + 132 + chipW + 18, chipY + 30);

  // The number.
  const roi = roiText(r);
  const headline = roi ?? (r.pnlUsd != null ? signedDollars(r.pnlUsd) : `SOLD ${dollars(r.sizeUsd)}`);
  let size = 230;
  ctx.font = `400 ${size}px ${display}`;
  while (ctx.measureText(headline).width > W - PAD * 2 && size > 110) { size -= 10; ctx.font = `400 ${size}px ${display}`; }
  ctx.fillStyle = roi || r.pnlUsd != null ? accent : TEXT; ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = up ? 'rgba(99, 240, 214, 0.35)' : 'rgba(255, 107, 107, 0.35)'; ctx.shadowBlur = 60;
  ctx.fillText(headline, PAD - 6, 720);
  ctx.shadowBlur = 0;
  if (roi && r.pnlUsd != null) {
    ctx.fillStyle = TEXT; ctx.font = `500 60px ${body}`;
    ctx.fillText(signedDollars(r.pnlUsd), PAD, 812);
    const wPnl = ctx.measureText(signedDollars(r.pnlUsd)).width;
    ctx.fillStyle = DIM; ctx.font = `400 34px ${body}`;
    ctx.fillText(up ? 'profit' : 'loss', PAD + wPnl + 18, 812);
  }

  // Entry / exit / size.
  const boxY = 880, boxH = 176;
  roundRect(ctx, PAD, boxY, W - PAD * 2, boxH, 36);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.045)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'; ctx.lineWidth = 2; ctx.stroke();
  const cols: [string, string][] = pred
    ? [['AVG PRICE', r.entryPrice == null ? '—' : cents(r.entryPrice)], ['SOLD AT', r.exitPrice == null ? '—' : cents(r.exitPrice)], ['SHARES', pred.shares.toFixed(0)]]
    : [['ENTRY', priceText(r.entryPrice)], ['EXIT', priceText(r.exitPrice)], [r.venue === 'perpl' ? 'SIZE' : 'VALUE', dollars(r.sizeUsd)]];
  const colW = (W - PAD * 2) / 3;
  cols.forEach(([label, value], i) => {
    const x = PAD + colW * i + 40;
    if (i > 0) { ctx.fillStyle = 'rgba(255, 255, 255, 0.1)'; ctx.fillRect(PAD + colW * i, boxY + 32, 2, boxH - 64); }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = DIM; ctx.font = `700 22px ${body}`; ctx.fillText(label, x, boxY + 68);
    ctx.fillStyle = TEXT; ctx.font = `500 40px ${body}`;
    let v = value; while (ctx.measureText(v).width > colW - 60 && v.length > 4) v = v.slice(0, -1);
    ctx.fillText(v === value ? v : `${v}…`, x, boxY + 126);
  });

  // Trader.
  const footY = 1150;
  const initials = r.traderName.trim().split(/[\s._-]+/).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || '?';
  circleImage(ctx, avatar, initials, PAD, footY, 96, body);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = TEXT; ctx.font = `500 40px ${body}`; ctx.fillText(r.traderName, PAD + 124, footY + 44);
  ctx.fillStyle = DIM; ctx.font = `400 28px ${body}`;
  ctx.fillText(`Closed ${new Date(r.closedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`, PAD + 124, footY + 86);
  ctx.textAlign = 'right'; ctx.fillStyle = MINT; ctx.font = `400 40px ${display}`;
  ctx.fillText('TRADE WITH', W - PAD, footY + 44);
  ctx.fillStyle = TEXT; ctx.fillText('YOUR CULT', W - PAD, footY + 88);

  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not draw the card.')), 'image/png'));
}
