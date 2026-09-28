'use client';

import { useState } from 'react';
import Image from 'next/image';
import { logoFor } from '@/lib/logos';

type Props = { symbol: string; imageUri?: string | null; className?: string };

export function TokenLogo({ symbol, imageUri, className = '' }: Props) {
  const src = logoFor(symbol, imageUri);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const letter = symbol.replace(/-PERP$/i, '').replace(/^\$/, '').slice(0, 1).toUpperCase();

  return <span className={`token-logo ${className}`} aria-hidden="true">
    {src && failedSrc !== src ? <Image src={src} alt="" width={40} height={40} unoptimized onError={() => setFailedSrc(src)} /> : <span>{letter || '?'}</span>}
  </span>;
}
