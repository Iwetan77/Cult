'use client';

import Image from 'next/image';

type Props = { name: string; url?: string | null; className?: string };

export function Avatar({ name, url, className = '' }: Props) {
  const base = process.env.NEXT_PUBLIC_CULT_API_BASE_URL?.replace(/\/$/, '');
  const src = url && base && url.startsWith('/') ? `${base}${url}` : null;
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || '?';
  return <span className={`room-avatar ${className}`} aria-label={name}>
    {initials}
    {src && <Image src={src} alt="" width={40} height={40} unoptimized onError={event => { event.currentTarget.hidden = true; }} />}
  </span>;
}
