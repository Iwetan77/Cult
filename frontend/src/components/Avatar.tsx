'use client';

import Image from 'next/image';

type Props = { name: string; url?: string | null; className?: string };

// Our API's avatar paths are relative to it; bundled images (/landing/…) and
// freshly picked photos (data:) are used as they are.
export const avatarSrc = (url: string | null | undefined) => {
  if (!url) return null;
  if (url.startsWith('data:') || url.startsWith('/landing/')) return url;
  const base = process.env.NEXT_PUBLIC_CULT_API_BASE_URL?.replace(/\/$/, '');
  return base && url.startsWith('/') ? `${base}${url}` : null;
};

export const initialsOf = (name: string) => name.trim().split(/[\s._-]+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || '?';

export function Avatar({ name, url, className = '' }: Props) {
  const src = avatarSrc(url);
  return <span className={`room-avatar ${className}`} aria-label={name}>
    {initialsOf(name)}
    {src && <Image src={src} alt="" width={64} height={64} unoptimized onError={event => { event.currentTarget.hidden = true; }} />}
  </span>;
}
