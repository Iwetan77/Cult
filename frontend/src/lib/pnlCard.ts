import { avatarSrc } from '@/components/Avatar';
import type { ChartMarker, Fill, Holding, PredictionPosition, PredictionSale, TradeSide, Venue } from './contracts';
import { cents } from './polymarket';
import { dollars, signedDollars } from './format';
import { logoFor } from './logos';
import { yieldToPage } from './gifFrames';

// The PnL card: one trade, drawn on a canvas so it can be saved or shared.
// From the Figma design ("Cult — PnL card"): the logo over a teal-to-black
// card, a big window (a reaction GIF from GIPHY when there is one), then the
// market and side, the return, entry / exit, invested and gain, and the
// trader on a cyan card. Built in the app from the position just before
// closing and the closing fill (the public share links only cover open
// positions).

export type TradeResult = {
  symbol: string; venue: Venue; side: TradeSide; leverage: number | null;
  entryPrice: number | null; exitPrice: number | null; sizeUsd: number | null;
  pnlUsd: number | null; roiPct: number | null; closedAt: number;
  investedUsd?: number | null; // what went in: the margin, or a bet's cost
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
    pnlUsd: sale.pnlUsd, roiPct: p.costUsd > 0 ? (sale.pnlUsd / p.costUsd) * 100 : null, closedAt: Date.now(), investedUsd: p.costUsd,
    traderName: trader.name, traderAvatarUrl: trader.avatarUrl,
    prediction: { title, sideLabel: p.sideLabel, yes: p.side === 'yes', shares: p.shares },
  };
}

// A prediction position priced at today's chance (0..1): the preview before
// selling, or (live) a card for a bet you keep.
export function resultOfPrediction(p: PredictionPosition, price: number, trader: { name: string; avatarUrl: string | null }, live = false): TradeResult {
  const title = p.outcomeLabel === p.question ? p.question : `${p.outcomeLabel} · ${p.eventTitle}`;
  const value = p.shares * price, pnl = value - p.costUsd;
  return {
    symbol: title, venue: 'nadfun', side: 'buy', leverage: null,
    entryPrice: p.avgPrice, exitPrice: price, sizeUsd: value,
    pnlUsd: pnl, roiPct: p.costUsd > 0 ? (pnl / p.costUsd) * 100 : null, closedAt: Date.now(), investedUsd: p.costUsd,
    traderName: trader.name, traderAvatarUrl: trader.avatarUrl,
    prediction: { title, sideLabel: p.sideLabel, yes: p.side === 'yes', shares: p.shares }, live,
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
    pnlUsd: pnl, roiPct: pnl != null && cost ? (pnl / cost) * 100 : null, closedAt: Date.now(), investedUsd: cost,
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
    pnlUsd: pnl, roiPct: pnl != null && cost ? (pnl / cost) * 100 : null, closedAt: Date.now(), investedUsd: cost,
    traderName: trader.name, traderAvatarUrl: trader.avatarUrl, live: true,
  };
}


export const roiText = (r: TradeResult) => r.roiPct == null ? null : `${r.roiPct > 0 ? '+' : ''}${r.roiPct.toFixed(1)}%`;
const priceText = (v: number | null) => v == null ? '—' : dollars(v, v < 1 ? 6 : 2);

// Designed in Figma at 1052×1476 ("Cult — PnL card", frame 14:5); drawn at any scale.
const W = 1052, H = 1476, X = 56, RADIUS = 46;
// card-frame.png is the card's teal-to-black background with the window cut
// out of it (the notch makes room for the logo). It sits over the window art.
const FRAME = { x: -99, y: -83, w: 1182, h: 1647 };
const WIN = { x: 53, y: 53, w: 946, h: 741 };
const GREEN = '#34d399', RED = '#ff6b6b', LABEL = '#797979', TEXT = '#ffffff';
const CHIP = { long: { bg: 'rgba(52, 211, 153, 0.19)', fg: GREEN }, short: { bg: 'rgba(255, 5, 5, 0.19)', fg: '#dd0000' } };
const TRADER = '#00d7e7';

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
// Bundled images and data: URLs, or another site's image fetched with CORS
// (the API's profile photos) so the canvas can still be exported.
const loadImage = (src: string | null) => new Promise<HTMLImageElement | null>(resolve => {
  if (!src || !(src.startsWith('/') || src.startsWith('data:') || src.startsWith('https://') || src.startsWith('http://'))) return resolve(null);
  const img = new Image();
  if (/^https?:/.test(src)) img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Tracking, as Figma sets it, where the browser supports it.
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

// A font size that fits the width, down to a floor; past that, an ellipsis.
function sized(ctx: CanvasRenderingContext2D, text: string, font: (px: number) => string, px: number, min: number, maxW: number) {
  let size = px;
  ctx.font = font(size);
  while (ctx.measureText(text).width > maxW && size > min) { size -= 2; ctx.font = font(size); }
  return fit(ctx, text, maxW);
}

const initialsOf = (name: string) => name.trim().split(/[\s._-]+/).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || '?';

function circleImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, initials: string, x: number, y: number, size: number, body: string) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); ctx.closePath();
  if (img) { ctx.clip(); ctx.drawImage(img, x, y, size, size); }
  else {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)'; ctx.fill();
    ctx.fillStyle = TEXT; ctx.font = `700 ${Math.round(size * 0.4)}px ${body}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(initials, x + size / 2, y + size / 2 + 2);
  }
  ctx.restore();
}

// An image filling a box edge to edge, cropped to it (object-fit: cover).
function cover(ctx: CanvasRenderingContext2D, source: CanvasImageSource, sw: number, sh: number, x: number, y: number, w: number, h: number, zoom = 1) {
  const s = Math.max(w / sw, h / sh) * zoom;
  ctx.drawImage(source, x + (w - sw * s) / 2, y + (h - sh * s) / 2, sw * s, sh * s);
}

// Fill the window edge to edge, then zoom in a little more so channel
// logos and watermarks burnt into a GIF's corners fall outside it.
const ZOOM = 1.16;

export async function prepareCard(r: TradeResult, scale = 1): Promise<CardRenderer> {
  const display = family('--font-insidia', 'Impact, sans-serif');
  const body = family('--font-aeonik', 'system-ui, sans-serif');
  await Promise.all([document.fonts.load(`400 170px ${display}`), document.fonts.load(`500 32px ${body}`), document.fonts.load(`700 48px ${body}`)]).catch(() => undefined);
  const [frame, logo, token, avatar] = await Promise.all([
    loadImage('/pnl/card-frame.png'), loadImage('/pnl/cult-logo.svg'),
    loadImage(r.prediction ? null : logoFor(r.symbol)), loadImage(avatarSrc(r.traderAvatarUrl)), // the API's photo path, made absolute
  ]);

  const width = Math.round(W * scale), height = Math.round(H * scale);
  const base = document.createElement('canvas');
  base.width = width; base.height = height;
  const ctx = base.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const up = (r.pnlUsd ?? 0) >= 0;
  const accent = up ? GREEN : RED;
  const pred = r.prediction;
  const roi = roiText(r);

  // The card: rounded, the frame image over everything but the window.
  roundRect(ctx, 0, 0, W, H, RADIUS); ctx.clip();
  if (frame) ctx.drawImage(frame, FRAME.x, FRAME.y, FRAME.w, FRAME.h);
  else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.clearRect(WIN.x, WIN.y, WIN.w, WIN.h); }
  if (logo) ctx.drawImage(logo, X, 68, 150, 78.763);

  // Market: token, name and the side chip ("10X SHORT").
  // A prediction has no token, so its question starts at the edge.
  const rowY = 847;
  if (!pred) circleImage(ctx, token, r.symbol.replace(/^\$/, '').slice(0, 1).toUpperCase(), X, rowY, 89, body);
  const nameX = pred ? X : X + 105;
  const short = pred ? !pred.yes : r.side === 'short';
  const chip = pred ? pred.sideLabel.toUpperCase() : r.side === 'buy' ? 'BUY' : `${r.leverage ?? 1}X ${r.side.toUpperCase()}`;
  ctx.font = `500 32px ${body}`;
  let chipW = 0;
  spaced(ctx, -0.32, () => { chipW = ctx.measureText(chip).width + 40; });
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  let nameW = 0;
  spaced(ctx, -0.48, () => {
    const name = sized(ctx, pred ? pred.title : r.symbol, px => `700 ${px}px ${body}`, 48, 30, W - X - nameX - 32 - chipW);
    ctx.fillStyle = TEXT; ctx.fillText(name, nameX, rowY + 44.5);
    nameW = ctx.measureText(name).width;
  });
  const chipX = nameX + nameW + 32, chipY = rowY + 16.5;
  roundRect(ctx, chipX, chipY, chipW, 56, 100);
  ctx.fillStyle = (short ? CHIP.short : CHIP.long).bg; ctx.fill();
  ctx.font = `500 32px ${body}`; ctx.fillStyle = (short ? CHIP.short : CHIP.long).fg;
  spaced(ctx, -0.32, () => ctx.fillText(chip, chipX + 20, chipY + 29));

  // The return, big. It stays clear of the trader card (x 753 on).
  const headline = roi ?? (r.pnlUsd != null ? signedDollars(r.pnlUsd) : `SOLD ${dollars(r.sizeUsd)}`);
  ctx.textBaseline = 'alphabetic';
  let k = 1;
  ctx.font = `400 170px ${display}`;
  while (ctx.measureText(headline).width > 753 - X - 24 && k > 0.5) { k -= 0.04; ctx.font = `400 ${170 * k}px ${display}`; }
  const centre = rowY + 129 + 58;
  ctx.fillStyle = roi || r.pnlUsd != null ? accent : TEXT;
  ctx.fillText(headline, X, centre + 58 * k);

  // Entry and exit, what went in and what came of it.
  const invested = r.investedUsd ?? (r.pnlUsd != null && r.roiPct ? r.pnlUsd / (r.roiPct / 100) : null);
  const stats: [string, string, string?][][] = [
    pred
      ? [['AVG PRICE', r.entryPrice == null ? '—' : cents(r.entryPrice)], [r.live ? 'PRICE NOW' : 'SOLD AT', r.exitPrice == null ? '—' : cents(r.exitPrice)]]
      : [['ENTRY PRICE', priceText(r.entryPrice)], [r.live ? 'MARK PRICE' : 'EXIT PRICE', priceText(r.exitPrice)]],
    [['INVESTED', invested == null ? '—' : dollars(invested)], ['GAIN/LOSS', r.pnlUsd == null ? '—' : signedDollars(r.pnlUsd), r.pnlUsd == null ? TEXT : accent]],
  ];
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  stats.forEach((row, i) => {
    const y = rowY + (i ? 424 : 285);
    row.forEach(([label, value, color], j) => {
      const x = X + j * 261;
      ctx.font = `500 32px ${body}`; ctx.fillStyle = LABEL;
      spaced(ctx, -0.96, () => ctx.fillText(label, x, y + 18));
      spaced(ctx, -0.48, () => {
        const v = sized(ctx, value, px => `700 ${px}px ${body}`, 48, 32, j ? 697 - 261 - 24 : 261 - 24);
        ctx.fillStyle = color ?? TEXT; ctx.fillText(v, x, y + 44 + 27.5);
      });
    });
  });

  // The trader: a square photo and their name, centred, on a cyan card.
  const tx = X + 697, ty = rowY + 208.034;
  roundRect(ctx, tx, ty, 245.985, 314.966, 34.985);
  ctx.fillStyle = TRADER; ctx.fill();
  const px = tx + 17.492, py = ty + 17.492, pw = 211, ph = 211;
  ctx.save();
  roundRect(ctx, px, py, pw, ph, 17.492); ctx.clip();
  if (avatar) cover(ctx, avatar, avatar.width, avatar.height, px, py, pw, ph);
  else {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)'; ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = TEXT; ctx.font = `400 80px ${display}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(initialsOf(r.traderName), px + pw / 2, py + ph / 2 + 4);
  }
  ctx.restore();
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = TEXT;
  ctx.fillText(sized(ctx, r.traderName.toUpperCase(), size => `400 ${size}px ${display}`, 40, 22, pw), px + pw / 2, ty + 256.48 + 27);
  ctx.textAlign = 'left';

  // The window when there is no GIF: the token (or the bet's side), large.
  const still = document.createElement('canvas');
  still.width = WIN.w; still.height = WIN.h;
  const sctx = still.getContext('2d')!;
  const wash = sctx.createLinearGradient(0, 0, 0, WIN.h);
  wash.addColorStop(0, '#16141f'); wash.addColorStop(1, '#0a090e');
  sctx.fillStyle = wash; sctx.fillRect(0, 0, WIN.w, WIN.h);
  if (pred) {
    sctx.fillStyle = accent; sctx.font = `400 240px ${display}`; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
    sctx.fillText(fit(sctx, pred.sideLabel.toUpperCase(), WIN.w - 120), WIN.w / 2, WIN.h / 2 + 50);
  } else {
    circleImage(sctx, token, r.symbol.replace(/^\$/, '').slice(0, 1).toUpperCase(), WIN.w / 2 - 130, WIN.h / 2 - 60, 260, body);
  }

  return {
    width, height,
    window: { x: Math.floor((WIN.x - 4) * scale), y: Math.floor((WIN.y - 4) * scale), w: Math.ceil((WIN.w + 8) * scale), h: Math.ceil((WIN.h + 8) * scale) },
    draw(out, art) {
      out.setTransform(1, 0, 0, 1, 0, 0);
      out.clearRect(0, 0, width, height);
      out.setTransform(scale, 0, 0, scale, 0, 0);
      out.save();
      out.beginPath(); out.rect(WIN.x, WIN.y, WIN.w, WIN.h); out.clip();
      if (art) cover(out, art.source, art.width, art.height, WIN.x, WIN.y, WIN.w, WIN.h, ZOOM);
      else out.drawImage(still, WIN.x, WIN.y);
      out.restore();
      out.setTransform(1, 0, 0, 1, 0, 0);
      out.drawImage(base, 0, 0);
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

// The animated card as a GIF at half size (526×738). One shared palette so
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
