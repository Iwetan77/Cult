import { getDb } from './db.js';

// Pictures members upload: cult pictures and photos sent in chat (profile
// photos live with the member, in store/members.ts). All arrive as data URLs,
// resized in the browser first; the bytes are checked against the type they
// claim before anything is stored.

export type Image = { mime: 'image/png' | 'image/jpeg' | 'image/webp'; bytes: Buffer };

export class ImageError extends Error {}

// "data:image/jpeg;base64,..." -> bytes, or why not.
export function decodeImage(dataUrl: string, maxBytes: number): Image {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new ImageError('send a PNG, JPEG or WebP as a data URL');
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length > maxBytes) throw new ImageError(`image is over ${Math.round(maxBytes / 1024)} KB; resize it first`);
  const sniff = bytes.subarray(0, 12);
  const isPng = sniff[0] === 0x89 && sniff[1] === 0x50 && sniff[2] === 0x4e && sniff[3] === 0x47;
  const isJpeg = sniff[0] === 0xff && sniff[1] === 0xd8 && sniff[2] === 0xff;
  const isWebp = sniff.subarray(0, 4).toString('ascii') === 'RIFF' && sniff.subarray(8, 12).toString('ascii') === 'WEBP';
  const mime = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : isWebp ? 'image/webp' : null;
  if (!mime || mime !== m[1]) throw new ImageError("that file isn't the image type it says it is");
  return { mime, bytes };
}

export const CULT_IMAGE_MAX_BYTES = 512 * 1024; // a 256px square is ~30 KB
export const CHAT_IMAGE_MAX_BYTES = 1536 * 1024; // a 1280px photo is ~100-400 KB

type Stored = { mime: string; bytes: Uint8Array; updatedAt: number };

export const cultImages = {
  set(clanId: string, image: Image) {
    getDb()
      .prepare('INSERT INTO cult_images (clan_id, mime, bytes, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(clan_id) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes, updated_at = excluded.updated_at')
      .run(clanId, image.mime, image.bytes, Date.now());
  },
  clear(clanId: string) {
    getDb().prepare('DELETE FROM cult_images WHERE clan_id = ?').run(clanId);
  },
  get(clanId: string): Stored | null {
    const r = getDb().prepare('SELECT mime, bytes, updated_at FROM cult_images WHERE clan_id = ?').get(clanId) as { mime: string; bytes: Uint8Array; updated_at: number } | undefined;
    return r ? { mime: r.mime, bytes: r.bytes, updatedAt: r.updated_at } : null;
  },
  // The picture's public URL (cache-busted by its last change), or null.
  url(clanId: string): string | null {
    const r = getDb().prepare('SELECT updated_at FROM cult_images WHERE clan_id = ?').get(clanId) as { updated_at: number } | undefined;
    return r ? `/v1/cult-images/${encodeURIComponent(clanId)}?v=${r.updated_at}` : null;
  },
};

// Chat photos are addressed by a random id: the URL is the key, so only
// people who can read the message (and so see its URL) can load the photo.
export const chatImages = {
  put(id: string, room: string, image: Image) {
    getDb().prepare('INSERT INTO chat_images (id, room, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)').run(id, room, image.mime, image.bytes, Date.now());
  },
  get(id: string): Stored | null {
    const r = getDb().prepare('SELECT mime, bytes, created_at FROM chat_images WHERE id = ?').get(id) as { mime: string; bytes: Uint8Array; created_at: number } | undefined;
    return r ? { mime: r.mime, bytes: r.bytes, updatedAt: r.created_at } : null;
  },
  url: (id: string | null | undefined) => (id ? `/v1/chat-images/${encodeURIComponent(id)}` : null),
};
