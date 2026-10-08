'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Forward } from './icons';
import type { Clan } from '@/lib/contracts';
import { RoomBadge } from './RoomBadge';

// Send this market's chart into one or more of your cults' chats, where it
// shows as a live card that opens the market (ChartShareCard).
export function SendChartControl({ symbol, cults, busy, onSend }: { symbol: string; cults: Clan[]; busy: boolean; onSend: (cultIds: string[]) => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);
  const toggle = (id: string) => setPicked(list => list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  const send = async () => {
    if (!picked.length) return;
    await onSend(picked);
    setOpen(false);
    setPicked([]);
  };

  return <div className="price-alert send-chart" ref={box}>
    <button className="icon-btn" aria-label={`Send the ${symbol} chart to a cult`} title="Send chart to a cult" aria-expanded={open} onClick={() => { setOpen(value => !value); if (!picked.length && cults.length === 1) setPicked([cults[0]!.id]); }}><Forward size={17} /></button>
    {open && <div className="alerts-drop price-alert-drop send-chart-drop" role="dialog" aria-label={`Send the ${symbol} chart`}>
      <div className="alerts-head"><h2>Send chart</h2><span className="count">{symbol}</span></div>
      {cults.length ? <>
        <div className="send-chart-cults" role="group" aria-label="Cults">{cults.map(cult => {
          const on = picked.includes(cult.id);
          return <button key={cult.id} type="button" className={`send-chart-cult${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(cult.id)}>
            <RoomBadge icon={cult.imageUrl ?? cult.name.trim()[0]?.toUpperCase() ?? 'C'} kind="cult" size="sm" />
            <span>{cult.name}</span>
            <i className="send-chart-check" aria-hidden="true">{on && <Check size={13} />}</i>
          </button>;
        })}</div>
        <button className="btn btn-primary btn-block" disabled={!picked.length || busy} onClick={() => void send()}>{picked.length > 1 ? `Send to ${picked.length} cults` : 'Send to cult'}</button>
      </> : <small className="price-alert-hint">Join or create a cult to send charts to it.</small>}
    </div>}
  </div>;
}
