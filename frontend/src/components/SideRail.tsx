'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronsLeft, ChevronsRight, Link2, LogOut, Plus, Settings } from 'lucide-react';
import type { ChatRoom, Me } from '@/lib/contracts';
import { timeAgo } from '@/lib/format';
import { RoomBadge } from './RoomBadge';

// The left panel: the main menu, then your cults and open rooms (markets
// live on the Markets page). Collapsed, it's a strip
// of icons that opens over the page while hovered; the expand button pins it
// open again. Settings and Log out sit at the bottom.

export type NavItem = { id: string; label: string; icon: ReactNode; active: boolean; onClick: () => void };

type Props = {
  me: Me | null; nav: NavItem[]; collapsed: boolean; onToggle: () => void;
  activeRoom: string | null;
  onRoom: (id: string) => void;
  onCreate: () => void; onJoin: () => void;
  settingsActive: boolean; onSettings: () => void; onSignOut: () => void;
};

const preview = (room: ChatRoom) => {
  const last = room.lastMessage;
  if (!last) return `${room.memberCount} ${room.memberCount === 1 ? 'member' : 'members'}`;
  return last.kind === 'system' ? last.text : `${last.memberName}: ${last.body}`;
};

export function SideRail({ me, nav, collapsed, onToggle, activeRoom, onRoom, onCreate, onJoin, settingsActive, onSettings, onSignOut }: Props) {
  // Hover-to-peek while collapsed, with a short delay each way so passing
  // the cursor across the strip doesn't flicker it open.
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<number | undefined>(undefined);
  const hover = (open: boolean) => {
    window.clearTimeout(peekTimer.current);
    if (!collapsed) return;
    peekTimer.current = window.setTimeout(() => setPeek(open), open ? 90 : 160);
  };
  useEffect(() => { window.clearTimeout(peekTimer.current); setPeek(false); }, [collapsed]);
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);
  const pick = (action: () => void) => { action(); setPeek(false); };

  const rooms = me?.rooms ?? [];
  const cults = rooms.filter(r => r.kind === 'cult');
  const open = rooms.filter(r => r.kind !== 'cult');
  const mini = collapsed && !peek;

  return <aside className={`rail ${collapsed ? 'rail--collapsed' : ''} ${collapsed && peek ? 'rail--peek' : ''}`} aria-label="Menu and cults"
    onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
    <div className="rail-top">
      {!mini && <span className="rail-label">Menu</span>}
      <button className="icon-btn rail-toggle" title={collapsed ? 'Expand panel' : 'Collapse panel'} aria-label={collapsed ? 'Expand panel' : 'Collapse panel'} onClick={() => { setPeek(false); onToggle(); }}>
        {collapsed ? <ChevronsRight size={17} /> : <ChevronsLeft size={17} />}
      </button>
    </div>
    <nav className="rail-nav" aria-label="Main navigation">
      {nav.map(item => <button key={item.id} className={item.active ? 'on' : ''} title={mini ? item.label : undefined} aria-current={item.active ? 'page' : undefined} onClick={() => pick(item.onClick)}>
        {item.icon}{!mini && <span>{item.label}</span>}
      </button>)}
    </nav>
    <div className="rail-divider" />

    {mini ? <>
      <div className="rail-mini">{rooms.map(room => <button key={room.id} title={room.name} className={activeRoom === room.id ? 'on' : ''} onClick={() => onRoom(room.id)}><RoomBadge icon={room.icon} kind={room.kind} /></button>)}</div>
      <button className="icon-btn rail-mini-add" title="Create a cult" onClick={onCreate}><Plus size={17} /></button>
    </> : <>
      <div className="rail-body">
        <div className="rail-label"><span>Your cults</span><b>{cults.length}</b></div>
        <div className="rail-list">
          {!me ? Array.from({ length: 3 }, (_, i) => <span key={i} className="skel rail-skel" />) : cults.length ? cults.map(room => <RoomItem key={room.id} room={room} active={activeRoom === room.id} onOpen={() => pick(() => onRoom(room.id))} />)
            : <div className="rail-empty"><strong>No cults yet</strong><span>Start one with friends or join with an invite.</span></div>}
        </div>
        <div className="rail-actions">
          <button className="btn btn-primary btn-sm btn-block" onClick={() => pick(onCreate)}><Plus size={15} /> Create a cult</button>
          <button className="btn btn-ghost btn-sm btn-block" onClick={() => pick(onJoin)}><Link2 size={15} /> Got an invite code?</button>
        </div>
        <div className="rail-label"><span>Open rooms</span></div>
        <div className="rail-list">{open.map(room => <RoomItem key={room.id} room={room} active={activeRoom === room.id} onOpen={() => pick(() => onRoom(room.id))} />)}</div>
      </div>
    </>}

    <div className="rail-nav rail-foot">
      <button className={settingsActive ? 'on' : ''} title={mini ? 'Settings' : undefined} aria-current={settingsActive ? 'page' : undefined} onClick={() => pick(onSettings)}><Settings size={18} />{!mini && <span>Settings</span>}</button>
      <button className="rail-logout" title={mini ? 'Log out' : undefined} onClick={onSignOut}><LogOut size={18} />{!mini && <span>Log out</span>}</button>
    </div>
  </aside>;
}

function RoomItem({ room, active, onOpen }: { room: ChatRoom; active: boolean; onOpen: () => void }) {
  const at = room.lastMessage ? Date.parse(room.lastMessage.createdAt) : null;
  return <button className={`rail-room ${active ? 'on' : ''}`} onClick={onOpen}>
    <RoomBadge icon={room.icon} kind={room.kind} />
    <span className="rail-room-lines"><strong>{room.name}</strong><small>{preview(room)}</small></span>
    {at != null && <time>{timeAgo(at)}</time>}
  </button>;
}
