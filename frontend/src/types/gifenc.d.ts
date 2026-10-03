// gifenc ships without types; just the parts the PnL card uses.
declare module 'gifenc' {
  export type Palette = number[][];
  export type FrameOptions = { palette?: Palette; delay?: number; repeat?: number; transparent?: boolean; transparentIndex?: number; dispose?: number };
  export type Encoder = {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: FrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
    // A live view of what has been written so far.
    bytesView(): Uint8Array;
  };
  export function GIFEncoder(opts?: { initialCapacity?: number; auto?: boolean }): Encoder;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' }): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: 'rgb565' | 'rgb444' | 'rgba4444'): Uint8Array;
}
