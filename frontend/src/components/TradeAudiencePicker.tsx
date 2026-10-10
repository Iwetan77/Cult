'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Lock, Users, X } from 'lucide-react';
import type { Clan } from '@/lib/contracts';
import { RoomBadge } from './RoomBadge';

export type TradeAudience = 'all' | string[];
type Cult = Pick<Clan, 'id' | 'name' | 'imageUrl'>;

export function tradeAudienceFromDefault(postTo: string): TradeAudience {
  return postTo === 'all' ? 'all' : postTo === 'none' ? [] : [postTo];
}

export function tradeAudienceIds(audience: TradeAudience, cults: readonly Cult[]): string[] | undefined {
  if (!cults.length) return [];
  if (audience === 'all') return undefined;
  const eligible = new Set(cults.map(cult => cult.id));
  return [...new Set(audience)].filter(id => eligible.has(id));
}

export function toggleTradeAudience(audience: TradeAudience, id: string, cults: readonly Cult[]): TradeAudience {
  if (!cults.some(cult => cult.id === id)) return audience;
  // Choosing a cult from All starts a deliberate, explicit audience.
  const selected = tradeAudienceIds(audience, cults) ?? [];
  return selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id];
}

export function TradeAudiencePicker({ cults, value, onChange }: {
  cults: readonly Cult[];
  value: TradeAudience;
  onChange: (value: TradeAudience) => void;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ top: 12, left: 12, width: 300 });
  const ids = tradeAudienceIds(value, cults);
  const selected = cults.filter(cult => ids?.includes(cult.id));
  const all = ids === undefined;
  const privateTrade = !all && !selected.length;
  const single = selected.length === 1 ? selected[0] : undefined;
  const label = all ? 'All my cults' : privateTrade ? 'Private' : single ? single.name : `${selected.length} cults`;
  const names = all ? `All my cults (${cults.length})` : privateTrade ? 'Only me (private)' : selected.map(cult => cult.name).join(', ');

  const position = useCallback(() => {
    if (!trigger.current || !panel.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 300), 360, window.innerWidth - 24);
    const height = Math.min(panel.current.offsetHeight, window.innerHeight - 24);
    const below = window.innerHeight - rect.bottom - 20;
    const top = below >= height || below >= rect.top - 20 ? rect.bottom + 8 : rect.top - height - 8;
    setPlace({ width, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), top: Math.max(12, Math.min(top, window.innerHeight - height - 12)) });
  }, []);

  useEffect(() => {
    if (!open) return;
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, position]);

  const close = (restoreFocus = true) => {
    panel.current?.hidePopover();
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const show = () => {
    if (panel.current?.matches(':popover-open')) { close(); return; }
    panel.current?.showPopover();
    setOpen(true);
    position();
    const selected = panel.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"], [aria-checked="true"]');
    (selected ?? panel.current?.querySelector<HTMLButtonElement>('[data-audience-option]'))?.focus();
  };

  return <div className="ticket-post trade-audience" ref={box}
    onBlur={event => { if (open && event.relatedTarget && !box.current?.contains(event.relatedTarget as Node)) close(false); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
    <span className="ticket-label" id={`${id}-label`}>Post to</span>
    <button type="button" ref={trigger} className={`trade-audience-trigger${open ? ' is-open' : ''}`}
      aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-panel`} title={names}
      onClick={show} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) show(); } }}>
      {single ? <RoomBadge icon={single.name.trim()[0]?.toUpperCase() ?? 'C'} imageUrl={single.imageUrl} kind="cult" size="sm" />
        : privateTrade ? <Lock size={16} aria-hidden="true" /> : <Users size={17} aria-hidden="true" />}
      <span id={`${id}-value`}>{label}</span>
      {all && <small className="num">{cults.length}</small>}
      <ChevronDown size={15} className="trade-audience-chevron" aria-hidden="true" />
    </button>
    <div ref={panel} id={`${id}-panel`} className="trade-audience-popover" popover="auto" role="dialog" aria-labelledby={`${id}-heading`}
      style={place} onToggle={event => setOpen(event.newState === 'open')}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-audience-option]'));
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        event.preventDefault();
        options[next]?.focus();
      }}>
      <div className="trade-audience-head">
        <h3 id={`${id}-heading`}>Post to</h3>
        <button type="button" className="trade-audience-close" aria-label="Close audience picker" title="Close" onClick={() => close()}><X size={18} aria-hidden="true" /></button>
      </div>
      <div className="trade-audience-modes" role="group" aria-label="Trade audience">
        <button type="button" data-audience-option className={`trade-audience-option${privateTrade ? ' is-selected' : ''}`} aria-pressed={privateTrade} onClick={() => { onChange([]); close(); }}>
          <span className="trade-audience-symbol"><Lock size={18} aria-hidden="true" /></span>
          <span className="trade-audience-copy"><strong>Only me</strong><small>Private trade</small></span>
          <span className="trade-audience-check" aria-hidden="true">{privateTrade && <Check size={14} />}</span>
        </button>
        <button type="button" data-audience-option className={`trade-audience-option${all ? ' is-selected' : ''}`} aria-pressed={all} onClick={() => { onChange('all'); close(); }}>
          <span className="trade-audience-symbol"><Users size={18} aria-hidden="true" /></span>
          <span className="trade-audience-copy"><strong>All my cults</strong><small>{cults.length} eligible {cults.length === 1 ? 'cult' : 'cults'}</small></span>
          <span className="trade-audience-check" aria-hidden="true">{all && <Check size={14} />}</span>
        </button>
      </div>
      <h4 className="trade-audience-label" id={`${id}-cults`}>Choose cults</h4>
      <div className="trade-audience-cults" role="group" aria-labelledby={`${id}-cults`}>
        {cults.map(cult => {
          const checked = selected.some(item => item.id === cult.id);
          return <button key={cult.id} type="button" data-audience-option role="checkbox" aria-checked={checked}
            className={`trade-audience-option${checked ? ' is-selected' : ''}`} onClick={() => onChange(toggleTradeAudience(value, cult.id, cults))}>
            <RoomBadge icon={cult.name.trim()[0]?.toUpperCase() ?? 'C'} imageUrl={cult.imageUrl} kind="cult" />
            <span className="trade-audience-copy"><strong>{cult.name}</strong></span>
            <span className="trade-audience-check" aria-hidden="true">{checked && <Check size={14} />}</span>
          </button>;
        })}
      </div>
      <div className="trade-audience-foot">
        <span aria-live="polite">{all ? 'All my cults' : privateTrade ? 'Private' : `${selected.length} selected`}</span>
        <button type="button" className="trade-audience-done" onClick={() => close()}>Done</button>
      </div>
    </div>
  </div>;
}
