'use client';

// A room's round badge: a letter (G for Global, a cult's first letter), a
// country flag, or an image once a room has one.

type Props = { icon: string; kind: 'global' | 'country' | 'cult'; imageUrl?: string | null; size?: 'sm' | 'md' | 'lg' };

const base = process.env.NEXT_PUBLIC_CULT_API_BASE_URL?.replace(/\/$/, '');

export function RoomBadge({ icon, kind, imageUrl, size = 'md' }: Props) {
  const raw = imageUrl ?? (/^(https?:\/\/|\/)/.test(icon) ? icon : null);
  const src = raw && raw.startsWith('/') && base ? `${base}${raw}` : raw;
  const flag = /^\p{Regional_Indicator}{2}$/u.test(icon);
  return <span className={`room-badge ${kind} ${size}${flag ? ' flag' : ''}`} aria-hidden="true">
    {/* Room images are small and come from our API or a CDN; a plain img keeps it simple. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {src ? <img src={src} alt="" /> : icon}
  </span>;
}
