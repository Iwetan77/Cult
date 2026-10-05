'use client';

import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { LogOut, Plus, Settings } from './icons';
import type { ChatRoom, Me } from '@/lib/contracts';
import { timeAgo } from '@/lib/format';
import { RoomBadge } from './RoomBadge';

// The left rail: a narrow strip of icons (main menu, your cults and open
// rooms as badges, Settings and Log out). Hovering it, or tabbing into it,
// widens it over the page to show labels and each room's latest message.
// Everything is always rendered; the width reveals it, so nothing jumps.

export type NavItem = { id: string; label: string; icon: ReactNode; active: boolean; onClick: () => void };

type Props = {
  me: Me | null; nav: NavItem[];
  activeRoom: string | null;
  onRoom: (id: string) => void;
  onCreate: () => void;
  settingsActive: boolean; onSettings: () => void; onSignOut: () => void;
};

const preview = (room: ChatRoom) => {
  const last = room.lastMessage;
  if (!last) return `${room.memberCount.toLocaleString()} ${room.memberCount === 1 ? 'member' : 'members'}`;
  return last.kind === 'system' ? last.text : `${last.memberName}: ${last.body}`;
};

export function SideRail({ me, nav, activeRoom, onRoom, onCreate, settingsActive, onSettings, onSignOut }: Props) {
  // A short delay each way, so passing the cursor across doesn't flicker it.
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const hover = (next: boolean) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(next), next ? 120 : 180);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const pick = (action: () => void) => { window.clearTimeout(timer.current); setOpen(false); action(); };
  const leaveFocus = (event: FocusEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); };

  const rooms = me?.rooms ?? [];
  const cults = rooms.filter(r => r.kind === 'cult');
  const others = rooms.filter(r => r.kind !== 'cult');
  const room = (r: ChatRoom) => {
    const at = r.lastMessage ? Date.parse(r.lastMessage.createdAt) : null;
    return <button key={r.id} className={`rail-room ${activeRoom === r.id ? 'on' : ''}`} title={open ? undefined : r.name} aria-label={r.name} onClick={() => pick(() => onRoom(r.id))}>
      <RoomBadge icon={r.icon} kind={r.kind} />
      <span className="rail-room-lines"><strong>{r.name}</strong><small>{preview(r)}</small></span>
      {at != null && <time>{timeAgo(at)}</time>}
    </button>;
  };

  return <aside className={`rail ${open ? 'is-open' : ''}`} aria-label="Menu and cults"
    onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)} onFocus={() => setOpen(true)} onBlur={leaveFocus}>
    <nav className="rail-group" aria-label="Main navigation">
      {nav.map(item => <button key={item.id} className={`rail-btn ${item.active ? 'on' : ''}`} aria-label={item.label} aria-current={item.active ? 'page' : undefined} onClick={() => pick(item.onClick)}>{item.icon}<span>{item.label}</span></button>)}
    </nav>
    <div className="rail-rooms" aria-label="Your cults and rooms">
      <div className="rail-label"><span>Your cults</span></div>
      {!me ? Array.from({ length: 3 }, (_, i) => <span key={i} className="skel rail-skel" />) : <>
        {cults.map(room)}
        <button className="rail-btn rail-add" aria-label="Create or join a cult" title={open ? undefined : 'Create or join a cult'} onClick={() => pick(onCreate)}><Plus size={17} /><span>Create or join a cult</span></button>
        {others.length > 0 && <div className="rail-label"><span>Open rooms</span></div>}
        {others.map(room)}
      </>}
    </div>
    <div className="rail-group rail-foot">
      <button className={`rail-btn ${settingsActive ? 'on' : ''}`} aria-label="Settings" aria-current={settingsActive ? 'page' : undefined} onClick={() => pick(onSettings)}><Settings size={18} /><span>Settings</span></button>
      <button className="rail-btn rail-logout" aria-label="Log out" onClick={() => pick(onSignOut)}><LogOut size={18} /><span>Log out</span></button>
    </div>
  </aside>;
}
