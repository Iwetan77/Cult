import type { ChartMarker, Fill, Holding, PredictionSale, TradeSide, Venue } from './contracts';
import { cents } from './polymarket';
import { dollars, signedDollars } from './format';
import { logoFor } from './logos';
import { yieldToPage } from './gifFrames';

// The PnL card: a trading card for one trade, drawn on a canvas so it can be
// saved or shared. Laid out like a collectible: a strip with leverage and a
// power bar, a big window (a reaction GIF from GIPHY when there is one), then
// the market, the return, and entry / exit / size beside the trader. Built in
// the app from the position just before closing and the closing fill (the
// public share links only cover open positions).

export type TradeResult = {
  symbol: string; venue: Venue; side: TradeSide; leverage: number | null;
  entryPrice: number | null; exitPrice: number | null; sizeUsd: number | null;
  pnlUsd: number | null; roiPct: number | null; closedAt: number;
  traderName: string; traderAvatarUrl: string | null;
  // Set for a prediction-market sale: prices are 0..1 and shown in cents.
  prediction?: { title: string; sideLabel: string; yes: boolean; shares: number };
  // A position still open, shared as it stands: exit is the mark price.
  live?: boolean;
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

// With no fill, the position is priced at its mark: a close preview, or a
// live card for a position you keep open.
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

// Your open position as the chart shows it, when your holdings haven't caught up yet.
export function resultOfMarker(m: ChartMarker, symbol: string, trader: { name: string; avatarUrl: string | null }): TradeResult {
  const perp = m.venue === 'perpl';
  const leverage = perp ? Math.max(1, m.leverage || 1) : 1;
  const cost = m.entryPrice != null && m.size ? (m.entryPrice * m.size) / leverage : null;
  const pnl = perp ? m.pnlUsd : null;
  return {
    symbol, venue: m.venue, side: m.side, leverage: perp ? leverage : null,
    entryPrice: m.entryPrice, exitPrice: m.markPrice, sizeUsd: m.valueUsd ?? (m.size != null ? m.size * m.markPrice : null),
    pnlUsd: pnl, roiPct: pnl != null && cost ? (pnl / cost) * 100 : null, closedAt: Date.now(),
    traderName: trader.name, traderAvatarUrl: trader.avatarUrl, live: true,
  };
}


export const roiText = (r: TradeResult) => r.roiPct == null ? null : `${r.roiPct > 0 ? '+' : ''}${r.roiPct.toFixed(1)}%`;
const priceText = (v: number | null) => v == null ? '—' : dollars(v, v < 1 ? 6 : 2);

// Designed at 1080×1350 (4:5); drawn at any scale.
const W = 1080, H = 1350, PAD = 64;
const WIN = { x: PAD, y: 196, w: W - PAD * 2, h: 660, r: 34 };
const MINT = '#63f0d6', RED = '#ff6b6b', INK = '#071b17', TEXT = '#f4f6f8', DIM = 'rgba(244, 246, 248, 0.55)', BG = '#070808';

// What fills the window: a GIF frame (or any image).
export type CardArt = { source: CanvasImageSource; width: number; height: number } | null;
// window: the GIF window in output pixels (with a margin for its rim).
export type CardRenderer = { width: number; height: number; window: { x: number; y: number; w: number; h: number }; draw: (ctx: CanvasRenderingContext2D, art: CardArt) => void };

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

// Letter-spaced caps where the browser supports it.
function spaced(ctx: CanvasRenderingContext2D, px: number, draw: () => void) {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  const before = c.letterSpacing;
  if (before !== undefined) c.letterSpacing = `${px}px`;
  draw();
  if (before !== undefined) c.letterSpacing = before;
}

function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, opts: { bg: string; color: string; stroke?: string; font: string; h?: number; align?: 'left' | 'right' }) {
  ctx.font = opts.font;
  const h = opts.h ?? 52, w = ctx.measureText(text).width + h * 0.9;
  const left = opts.align === 'right' ? x - w : x;
  roundRect(ctx, left, y, w, h, h / 2);
  ctx.fillStyle = opts.bg; ctx.fill();
  if (opts.stroke) { ctx.strokeStyle = opts.stroke; ctx.lineWidth = 2; ctx.stroke(); }
  ctx.fillStyle = opts.color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText(text, left + h * 0.45, y + h / 2 + 2);
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

// Fill the window edge to edge, then zoom in a little more so channel
// logos and watermarks burnt into a GIF's corners fall outside it.
const ZOOM = 1.16;
function drawCover(ctx: CanvasRenderingContext2D, art: NonNullable<CardArt>) {
  const s = Math.max(WIN.w / art.width, WIN.h / art.height) * ZOOM;
  const w = art.width * s, h = art.height * s;
  ctx.drawImage(art.source, WIN.x + (WIN.w - w) / 2, WIN.y + (WIN.h - h) / 2, w, h);
}

export async function prepareCard(r: TradeResult, scale = 1): Promise<CardRenderer> {
  const display = family('--font-insidia', 'Impact, sans-serif');
  const body = family('--font-aeonik', 'system-ui, sans-serif');
  await Promise.all([document.fonts.load(`400 200px ${display}`), document.fonts.load(`500 40px ${body}`), document.fonts.load(`700 40px ${body}`)]).catch(() => undefined);
  const [rays, logo, token, avatar] = await Promise.all([loadImage('/landing/rays-bg.png'), loadImage('/landing/cult-logo.svg'), loadImage(logoFor(r.symbol)), loadImage(r.traderAvatarUrl)]);

  const width = Math.round(W * scale), height = Math.round(H * scale);
  const base = document.createElement('canvas');
  base.width = width; base.height = height;
  const ctx = base.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const up = (r.pnlUsd ?? 0) >= 0;
  const accent = up ? MINT : RED;
  const accentRgb = up ? '99, 240, 214' : '255, 107, 107';
  const pred = r.prediction;
  const roi = roiText(r);

  // Card: black, an accent glow from the top right, a thin accent rim.
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.85, 120, 0, W * 0.85, 120, 760);
  glow.addColorStop(0, `rgba(${accentRgb}, 0.16)`); glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  const low = ctx.createRadialGradient(W * 0.1, H - 120, 0, W * 0.1, H - 120, 640);
  low.addColorStop(0, `rgba(${accentRgb}, 0.08)`); low.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = low; ctx.fillRect(0, 0, W, H);
  roundRect(ctx, 14, 14, W - 28, H - 28, 46);
  ctx.strokeStyle = `rgba(${accentRgb}, 0.28)`; ctx.lineWidth = 3; ctx.stroke();

  // Top strip, left: a slanted power bar (how big the move was) and leverage.
  const segs = 14, segW = 30, segH = 26, gap = 7, skew = 9;
  const lit = Math.max(1, Math.min(segs, Math.round((Math.abs(r.roiPct ?? (r.pnlUsd ? 20 : 0)) / 60) * segs)));
  for (let i = 0; i < segs; i++) {
    const x = PAD + i * (segW + gap);
    ctx.beginPath(); ctx.moveTo(x + skew, 70); ctx.lineTo(x + segW + skew, 70); ctx.lineTo(x + segW, 70 + segH); ctx.lineTo(x, 70 + segH); ctx.closePath();
    ctx.fillStyle = i < lit ? accent : 'rgba(255, 255, 255, 0.1)'; ctx.fill();
  }
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const [levLabel, levValue] = pred ? ['BET', pred.sideLabel.toUpperCase()] : r.venue === 'perpl' ? ['LEV', `${r.leverage ?? 1}X`] : ['SPOT', 'BUY'];
  spaced(ctx, 4, () => {
    ctx.font = `700 30px ${body}`; ctx.fillStyle = DIM; ctx.fillText(levLabel, PAD, 150);
    const lw = ctx.measureText(`${levLabel} `).width;
    ctx.fillStyle = TEXT; ctx.fillText(fit(ctx, levValue, 420), PAD + lw + 6, 150);
  });

  // Top strip, right: the logo, and whether the trade is closed or live.
  if (logo) { const lw = 110, lh = lw * (logo.height / logo.width || 30 / 58); ctx.drawImage(logo, W - PAD - lw, 58, lw, lh); }
  else { ctx.fillStyle = TEXT; ctx.font = `400 56px ${display}`; ctx.textAlign = 'right'; ctx.fillText('CULT', W - PAD, 116); }
  ctx.textAlign = 'right';
  spaced(ctx, 4, () => { ctx.font = `700 22px ${body}`; ctx.fillStyle = r.live ? accent : DIM; ctx.fillText(r.live ? '● LIVE POSITION' : 'CLOSED TRADE', W - PAD, 150); });

  // Window background, and the still art used when there is no GIF.
  ctx.save();
  roundRect(ctx, WIN.x, WIN.y, WIN.w, WIN.h, WIN.r); ctx.clip();
  ctx.fillStyle = '#0c0d0e'; ctx.fillRect(WIN.x, WIN.y, WIN.w, WIN.h);
  ctx.restore();
  const still = document.createElement('canvas');
  still.width = WIN.w; still.height = WIN.h;
  const sctx = still.getContext('2d')!;
  sctx.fillStyle = '#0c0d0e'; sctx.fillRect(0, 0, WIN.w, WIN.h);
  if (rays) { sctx.globalAlpha = up ? 0.6 : 0.3; sctx.drawImage(rays, -80, -140, WIN.w + 160, (WIN.w + 160) * rays.height / rays.width); sctx.globalAlpha = 1; }
  const fade = sctx.createLinearGradient(0, 0, 0, WIN.h);
  fade.addColorStop(0, 'rgba(12, 13, 14, 0)'); fade.addColorStop(1, 'rgba(12, 13, 14, 0.9)');
  sctx.fillStyle = fade; sctx.fillRect(0, 0, WIN.w, WIN.h);
  if (pred) {
    sctx.fillStyle = accent; sctx.font = `400 260px ${display}`; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
    sctx.fillText(pred.sideLabel.toUpperCase().slice(0, 6), WIN.w / 2, WIN.h / 2 + 10);
  } else {
    circleImage(sctx, token, r.symbol.replace(/^\$/, '').slice(0, 1).toUpperCase(), WIN.w / 2 - 110, WIN.h / 2 - 110, 220, body);
  }

  // Market line, like a card's set and number.
  const marketY = 930;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  const kind = pred ? 'POLYMARKET' : r.venue === 'perpl' ? 'PERPETUAL' : 'MEME';
  const when = new Date(r.closedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
  spaced(ctx, 3, () => {
    ctx.font = `700 26px ${body}`;
    const dateW = ctx.measureText(when).width;
    ctx.fillStyle = DIM; ctx.textAlign = 'right'; ctx.fillText(when, W - PAD, marketY);
    ctx.textAlign = 'left'; ctx.fillStyle = TEXT;
    const name = pred ? pred.title.toUpperCase() : r.symbol.toUpperCase();
    ctx.fillText(fit(ctx, `${name} · ${kind}`, W - PAD * 2 - dateW - 40), PAD, marketY);
  });

  // The return, big, with the dollar figure beside it.
  const headline = roi ?? (r.pnlUsd != null ? signedDollars(r.pnlUsd) : `SOLD ${dollars(r.sizeUsd)}`);
  const side = roi && r.pnlUsd != null ? { label: up ? 'PROFIT' : 'LOSS', value: signedDollars(r.pnlUsd) } : null;
  ctx.font = `500 54px ${body}`;
  const sideW = side ? Math.max(ctx.measureText(side.value).width, 120) + 32 : 0;
  let size = 200;
  ctx.font = `400 ${size}px ${display}`;
  while (ctx.measureText(headline).width > W - PAD * 2 - sideW && size > 96) { size -= 8; ctx.font = `400 ${size}px ${display}`; }
  const headY = 1098;
  ctx.fillStyle = roi || r.pnlUsd != null ? accent : TEXT;
  // A light glow: a strong one bands into blotches in a 256-colour GIF.
  ctx.shadowColor = `rgba(${accentRgb}, 0.22)`; ctx.shadowBlur = 34;
  ctx.fillText(headline, PAD - 4, headY);
  ctx.shadowBlur = 0;
  if (side) {
    ctx.textAlign = 'right';
    spaced(ctx, 4, () => { ctx.font = `700 22px ${body}`; ctx.fillStyle = DIM; ctx.fillText(side.label, W - PAD, headY - 64); });
    ctx.font = `500 54px ${body}`; ctx.fillStyle = TEXT; ctx.fillText(side.value, W - PAD, headY - 6);
    ctx.textAlign = 'left';
  }

  // Bottom row: three stat boxes and the trader, like the card's icon row.
  const rowY = 1150, rowH = 140, who = rowH;
  const cols: [string, string][] = pred
    ? [['AVG PRICE', r.entryPrice == null ? '—' : cents(r.entryPrice)], [r.live ? 'NOW' : 'SOLD AT', r.exitPrice == null ? '—' : cents(r.exitPrice)], ['SHARES', pred.shares.toFixed(0)]]
    : [['ENTRY', priceText(r.entryPrice)], [r.live ? 'MARK' : 'EXIT', priceText(r.exitPrice)], [r.venue === 'perpl' ? 'SIZE' : 'VALUE', dollars(r.sizeUsd)]];
  const boxGap = 16, boxW = (W - PAD * 2 - who - 20 - boxGap * 2) / 3;
  cols.forEach(([label, value], i) => {
    const x = PAD + i * (boxW + boxGap);
    roundRect(ctx, x, rowY, boxW, rowH, 22);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.textAlign = 'left';
    spaced(ctx, 3, () => { ctx.font = `700 20px ${body}`; ctx.fillStyle = DIM; ctx.fillText(label, x + 24, rowY + 50); });
    ctx.font = `500 36px ${body}`; ctx.fillStyle = TEXT; ctx.fillText(fit(ctx, value, boxW - 44), x + 24, rowY + 106);
  });
  const whoX = W - PAD - who;
  roundRect(ctx, whoX, rowY, who, rowH, 22);
  ctx.strokeStyle = `rgba(${accentRgb}, 0.5)`; ctx.lineWidth = 3; ctx.stroke();
  const initials = r.traderName.trim().split(/[\s._-]+/).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || '?';
  circleImage(ctx, avatar, initials, whoX + (who - 68) / 2, rowY + 16, 68, body);
  ctx.font = `500 22px ${body}`; ctx.fillStyle = TEXT; ctx.textAlign = 'center';
  ctx.fillText(fit(ctx, r.traderName, who - 20), whoX + who / 2, rowY + 118);

  const shortSide = pred ? !pred.yes : r.side === 'short';
  const chip = pred ? pred.sideLabel.toUpperCase() : r.side === 'buy' ? 'BUY' : `${r.side.toUpperCase()}${r.leverage ? ` ${r.leverage}X` : ''}`;

  return {
    width, height,
    window: { x: Math.floor((WIN.x - 4) * scale), y: Math.floor((WIN.y - 4) * scale), w: Math.ceil((WIN.w + 8) * scale), h: Math.ceil((WIN.h + 8) * scale) },
    draw(out, art) {
      out.setTransform(1, 0, 0, 1, 0, 0);
      out.drawImage(base, 0, 0);
      out.setTransform(scale, 0, 0, scale, 0, 0);
      out.save();
      roundRect(out, WIN.x, WIN.y, WIN.w, WIN.h, WIN.r); out.clip();
      if (art) drawCover(out, art); else out.drawImage(still, WIN.x, WIN.y);
      // A soft fade at the bottom so the window sits into the card.
      const shade = out.createLinearGradient(0, WIN.y + WIN.h - 170, 0, WIN.y + WIN.h);
      shade.addColorStop(0, 'rgba(7, 8, 8, 0)'); shade.addColorStop(1, 'rgba(7, 8, 8, 0.6)');
      out.fillStyle = shade; out.fillRect(WIN.x, WIN.y + WIN.h - 170, WIN.w, 170);
      out.restore();
      roundRect(out, WIN.x, WIN.y, WIN.w, WIN.h, WIN.r);
      out.strokeStyle = 'rgba(255, 255, 255, 0.16)'; out.lineWidth = 3; out.stroke();
      // Side chip and token over the window's top corners.
      pill(out, chip, WIN.x + 24, WIN.y + 24, { bg: shortSide ? RED : MINT, color: shortSide ? '#2a0707' : INK, font: `700 24px ${body}` });
      if (!pred && art) circleImage(out, token, r.symbol.replace(/^\$/, '').slice(0, 1).toUpperCase(), WIN.x + WIN.w - 24 - 64, WIN.y + 24, 64, body);
      out.setTransform(1, 0, 0, 1, 0, 0);
    },
  };
}

const toBlob = (canvas: HTMLCanvasElement, type: string) => new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not draw the card.')), type));

// A still PNG: the full-size card with the given art (or the still art).
export async function drawPnlCard(r: TradeResult, art: CardArt = null): Promise<Blob> {
  const card = await prepareCard(r, 1);
  const canvas = document.createElement('canvas');
  canvas.width = card.width; canvas.height = card.height;
  card.draw(canvas.getContext('2d')!, art);
  return toBlob(canvas, 'image/png');
}

// Nearest palette colour per pixel, with one cache (by RGB565) shared across
// every frame: the same colours repeat frame to frame, so lookups stay cheap.
function paletteMapper(palette: number[][]) {
  const cache = new Int16Array(65536).fill(-1);
  return (rgba: Uint8ClampedArray) => {
    const n = rgba.length >> 2, out = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = rgba[p]!, g = rgba[p + 1]!, b = rgba[p + 2]!;
      const key = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
      let idx = cache[key]!;
      if (idx < 0) {
        let best = 0, bestD = Infinity;
        for (let j = 0; j < palette.length; j++) {
          const c = palette[j]!, dr = r - c[0]!, dg = g - c[1]!, db = b - c[2]!;
          const d = dr * dr + dg * dg + db * db;
          if (d < bestD) { bestD = d; best = j; }
        }
        idx = cache[key] = best;
      }
      out[i] = idx;
    }
    return out;
  };
}

// The animated card as a GIF at half size (540×675). One shared palette so
// the still parts don't shimmer; after the first full frame only the window
// is written (the rest of the card never changes), which keeps the file
// small and the encode quick.
export async function encodePnlGif(r: TradeResult, gif: { width: number; height: number; frames: { image: CanvasImageSource; delay: number }[] }, onProgress?: (done: number) => void): Promise<Blob> {
  const { GIFEncoder, quantize } = await import('gifenc');
  const card = await prepareCard(r, 0.5);
  const canvas = document.createElement('canvas');
  canvas.width = card.width; canvas.height = card.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const art = (i: number): CardArt => ({ source: gif.frames[i]!.image, width: gif.width, height: gif.height });
  const win = card.window;
  const read = (i: number, full: boolean) => { card.draw(ctx, art(i)); return full ? ctx.getImageData(0, 0, card.width, card.height).data : ctx.getImageData(win.x, win.y, win.w, win.h).data; };

  // Palette from a few frames spread through the clip.
  const picks = [...new Set([0, Math.floor(gif.frames.length / 3), Math.floor((gif.frames.length * 2) / 3), gif.frames.length - 1])];
  const samples = picks.map(i => read(i, true));
  const sample = new Uint8ClampedArray(samples.reduce((n, s) => n + s.length / 2, 0));
  let o = 0;
  for (const s of samples) for (let p = 0; p < s.length; p += 8) { sample[o++] = s[p]!; sample[o++] = s[p + 1]!; sample[o++] = s[p + 2]!; sample[o++] = s[p + 3]!; }
  const palette = quantize(sample.subarray(0, o), 256);
  const map = paletteMapper(palette);

  const encoder = GIFEncoder();
  for (let i = 0; i < gif.frames.length; i++) {
    const delay = gif.frames[i]!.delay;
    if (i === 0) encoder.writeFrame(map(read(0, true)), card.width, card.height, { palette, delay });
    else {
      // gifenc always places a frame at 0,0: write the window's size, then
      // set its position in the image descriptor (after the 8-byte control
      // block: 0x2C, then left and top, little-endian).
      const at = encoder.bytesView().length;
      encoder.writeFrame(map(read(i, false)), win.w, win.h, { delay });
      const bytes = encoder.bytesView();
      if (bytes[at + 8] === 0x2c) { bytes[at + 9] = win.x & 0xff; bytes[at + 10] = win.x >> 8; bytes[at + 11] = win.y & 0xff; bytes[at + 12] = win.y >> 8; }
    }
    onProgress?.((i + 1) / gif.frames.length);
    await yieldToPage();
  }
  encoder.finish();
  return new Blob([encoder.bytes() as BlobPart], { type: 'image/gif' });
}
