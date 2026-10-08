'use client';

import { useState } from 'react';

// A room's round badge: a letter (G for Global, a cult's first letter), a
// country flag, or an image once a room has one (a URL or data URL in `icon`,
// or `imageUrl`). Flags are drawn as images: Windows can't render flag emoji
// and shows two letters instead.

type Props = { icon: string; kind: 'global' | 'country' | 'cult'; imageUrl?: string | null; size?: 'sm' | 'md' | 'lg' };

const base = process.env.NEXT_PUBLIC_CULT_API_BASE_URL?.replace(/\/$/, '');

// 🇳🇬 -> "ng"
const flagCode = (icon: string) => {
  const letters = [...icon].map(ch => ch.codePointAt(0)! - 0x1f1e6);
  return letters.length === 2 && letters.every(n => n >= 0 && n < 26) ? String.fromCharCode(...letters.map(n => 97 + n)) : null;
};

export function RoomBadge({ icon, kind, imageUrl, size = 'md' }: Props) {
  const [failed, setFailed] = useState(false);
  const code = flagCode(icon);
  const image = /^(https?:\/\/|\/|data:image\/)/.test(icon);
  const raw = imageUrl ?? (image ? icon : code ? `https://flagcdn.com/w80/${code}.png` : null);
  const src = raw && raw.startsWith('/') && base ? `${base}${raw}` : raw;
  const fallback = code ? code.toUpperCase() : image ? '' : icon;
  return <span className={`room-badge ${kind} ${size}${code ? ' flag' : ''}`} aria-hidden="true">
    {/* Room images are small and come from our API or a CDN; a plain img keeps it simple. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : fallback}
  </span>;
}
