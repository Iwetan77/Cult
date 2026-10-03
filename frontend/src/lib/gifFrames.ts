import { decompressFrames, parseGIF } from 'gifuct-js';

// A GIF unpacked into whole frames (canvases) with their delays, so the PnL
// card can draw each one into its window. Long GIFs are cut to a few
// seconds and thinned to a frame budget so the exported card stays small.

// Give the page a turn between heavy steps. A message, not a timer: timers
// get throttled hard when the tab isn't in front.
export const yieldToPage = () => new Promise<void>(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0); });

export type GifFrame = { image: HTMLCanvasElement; delay: number };
export type GifFrames = { width: number; height: number; frames: GifFrame[] };

export async function loadGifFrames(url: string, { maxFrames = 40, maxMs = 4200 } = {}): Promise<GifFrames> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load the GIF.');
  const parsed = parseGIF(await response.arrayBuffer());
  const raw = decompressFrames(parsed, true);
  if (!raw.length) throw new Error('The GIF has no frames.');
  const width = parsed.lsd.width, height = parsed.lsd.height;

  // Browsers treat a delay under 20ms as 100ms; do the same.
  const delays = raw.map(f => (f.delay >= 20 ? f.delay : 100));
  let count = 0, elapsed = 0;
  while (count < raw.length && (count === 0 || elapsed + delays[count]! <= maxMs)) elapsed += delays[count++]!;
  const step = Math.max(1, Math.ceil(count / maxFrames));

  const full = document.createElement('canvas');
  full.width = width; full.height = height;
  const ctx = full.getContext('2d', { willReadFrequently: true })!;
  const patch = document.createElement('canvas');
  const patchCtx = patch.getContext('2d')!;
  const frames: GifFrame[] = [];
  let restore: ImageData | null = null;

  for (let i = 0; i < count; i++) {
    const f = raw[i]!;
    const { left, top, width: w, height: h } = f.dims;
    // Disposal 3 restores what was there before this frame.
    if (f.disposalType === 3) restore = ctx.getImageData(0, 0, width, height);
    // Through a canvas so transparent pixels keep what's underneath.
    patch.width = w; patch.height = h;
    patchCtx.putImageData(new ImageData(new Uint8ClampedArray(f.patch), w, h), 0, 0);
    ctx.drawImage(patch, left, top);

    const slot = Math.floor(i / step);
    if (i % step === 0) {
      const image = document.createElement('canvas');
      image.width = width; image.height = height;
      image.getContext('2d')!.drawImage(full, 0, 0);
      frames.push({ image, delay: 0 });
    }
    frames[slot]!.delay += delays[i]!;

    if (f.disposalType === 2) ctx.clearRect(left, top, w, h);
    else if (f.disposalType === 3 && restore) { ctx.putImageData(restore, 0, 0); restore = null; }
    // Let the page breathe on big GIFs.
    if (i % 12 === 11) await yieldToPage();
  }
  return { width, height, frames };
}
