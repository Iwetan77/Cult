'use client';

import { Avatar } from './Avatar';
import { ArrowRight } from './icons';
import { TokenLogo } from './TokenLogo';
import { copyCardText, type CopyGroup } from '@/lib/copyGroups';

// Everyone who copied one trade, as one card: their faces stacked, "You and
// 23 others copied 23daddy's SOL-PERP long", and a way to that trade on the
// chart. New copiers pop into the stack as their copies land.

const SHOWN = 3;

export function CopyCard({ group, meId, time, onOpen }: { group: CopyGroup; meId?: string; time: string; onOpen: (markerId: string) => void }) {
  const faces = [...group.copiers].sort((a, b) => Number(b.id === meId) - Number(a.id === meId)).slice(0, SHOWN);
  const more = group.copiers.length - faces.length;
  const symbol = group.position.split(' ')[0] ?? '';
  return <div className={`copy-card copy-card--${group.phase}`}>
    <div className="copy-card-faces" aria-hidden="true">
      {faces.map(c => <span className="copy-card-face" key={c.id}><Avatar name={c.name} url={c.avatarUrl} /></span>)}
      {more > 0 && <span className="copy-card-face copy-card-more" key={`more-${more}`}>+{more}</span>}
    </div>
    <div className="copy-card-main">
      <span className="copy-card-text">{copyCardText(group, meId)}</span>
      <small><TokenLogo symbol={symbol} /> {group.phase === 'open' ? 'Copied' : 'Copies closed'} · <time>{time}</time></small>
    </div>
    <button type="button" className="chat-trade-open" onClick={() => onOpen(group.copyOf.markerId)}>View on chart <ArrowRight size={13} /></button>
  </div>;
}
