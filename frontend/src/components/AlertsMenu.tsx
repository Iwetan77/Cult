'use client';

import { useEffect, useRef, useState } from 'react';
import { Bell, TrendingUp, UsersRound, X } from './icons';
import { price, timeAgo } from '@/lib/format';
import { addPriceAlert, clearAlerts, markAlertsRead, notifyPref, removePriceAlert, setNotifyPref, useAlertFeed, useNotifyPref, usePriceAlerts, type AlertItem } from '@/lib/prefs';

// Alerts: a cult-mate opening a trade, price alerts you set on a market and,
// with notifications on, new cult messages. They're watched in the browser
// while Cult is open (see Dashboard) and kept on this device. With
// notifications on (Settings) and the browser's permission, they also show as
// system notifications when Cult is in the background.

const canNotify = () => typeof window !== 'undefined' && 'Notification' in window;

export function notifyDevice(owner: string, title: string, body: string) {
  if (!notifyPref(owner) || !canNotify() || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  try { new Notification(title, { body, icon: '/landing/cult-logo.svg' }); } catch { /* some browsers only notify from a service worker */ }
}

// Turn notifications on: the setting, plus the browser's permission for
// system notifications where it can still be asked for. Returns the permission.
export async function enableNotifications(owner: string): Promise<NotificationPermission | 'unsupported'> {
  setNotifyPref(owner, true);
  if (!canNotify()) return 'unsupported';
  if (Notification.permission === 'default') return Notification.requestPermission().catch(() => Notification.permission);
  return Notification.permission;
}

export function AlertsMenu({ owner, onMarket, onRoom }: { owner: string; onMarket: (id: string) => void; onRoom: (id: string) => void }) {
  const feed = useAlertFeed(owner);
  const watching = usePriceAlerts(owner);
  const [open, setOpen] = useState(false);
  const notifying = useNotifyPref(owner);
  const box = useRef<HTMLDivElement>(null);
  const unread = feed.some(a => !a.read);

  // Opening the panel reads everything in it.
  useEffect(() => { if (open) markAlertsRead(owner); }, [open, feed, owner]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const pick = (item: AlertItem) => {
    setOpen(false);
    if (item.marketId) onMarket(item.marketId);
    else if (item.roomId) onRoom(item.roomId);
  };

  return <div className="alerts" ref={box}>
    <button className={`icon-btn alerts-bell${open ? ' on' : ''}`} aria-label={unread ? 'Alerts, new' : 'Alerts'} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Bell size={18} />{unread && <i className="alerts-dot" aria-hidden="true" />}
    </button>
    {open && <div className="alerts-drop" role="dialog" aria-label="Alerts">
      <div className="alerts-head"><h2>Alerts</h2>{feed.length > 0 && <button className="link" onClick={() => clearAlerts(owner)}>Clear</button>}</div>
      {!notifying && <button className="alerts-permission" onClick={() => void enableNotifications(owner)}><Bell size={15} /><span><strong>Turn on notifications</strong><small>An alert for every new message and trade, even when Cult is in the background.</small></span></button>}
      {feed.length ? <div className="alerts-list">{feed.map(item => <button key={item.id} className="alerts-item" onClick={() => pick(item)}>
        <span className={`alerts-icon is-${item.kind}`}>{item.kind === 'price' ? <TrendingUp size={15} /> : <UsersRound size={15} />}</span>
        <span className="alerts-lines"><strong>{item.title}</strong><small>{item.body} · {timeAgo(item.at)}</small></span>
      </button>)}</div> : <p className="alerts-empty">Nothing yet. You&apos;ll see your cult&apos;s new trades and your price alerts here.</p>}
      <div className="alerts-sub">
        <h3>Price alerts</h3>
        {watching.length ? watching.map(a => <div key={a.id} className="alerts-watch">
          <button className="alerts-watch-name" onClick={() => { setOpen(false); onMarket(a.marketId); }}><strong>{a.symbol}</strong><small>{a.direction === 'above' ? 'Above' : 'Below'} <span className="num">{price(a.price)}</span></small></button>
          <button className="icon-btn icon-btn--sm" aria-label={`Remove ${a.symbol} alert`} onClick={() => removePriceAlert(owner, a.id)}><X size={14} /></button>
        </div>) : <p className="alerts-empty">Set one from any market&apos;s page with the bell.</p>}
      </div>
    </div>}
  </div>;
}

// On a market page: set a price alert for it and see the ones already set.
export function PriceAlertControl({ owner, marketId, symbol, current }: { owner: string; marketId: string; symbol: string; current: number | null }) {
  const watching = usePriceAlerts(owner).filter(a => a.marketId === marketId);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);
  const target = Number(text);
  const valid = text !== '' && Number.isFinite(target) && target > 0 && current != null && target !== current;
  const direction = current != null && target > current ? 'above' : 'below';
  const save = () => {
    if (!valid) return;
    addPriceAlert(owner, { marketId, symbol, direction, price: target });
    setText('');
  };
  return <div className="price-alert" ref={box}>
    <button className={`icon-btn${watching.length ? ' is-set' : ''}`} aria-label={`Price alerts for ${symbol}`} aria-expanded={open} onClick={() => { setOpen(value => !value); if (!text && current != null) setText(String(Number(current.toPrecision(5)))); }}><Bell size={17} /></button>
    {open && <div className="alerts-drop price-alert-drop" role="dialog" aria-label={`Price alert for ${symbol}`}>
      <div className="alerts-head"><h2>Alert me</h2><span className="count">Now <span className="num">{price(current)}</span></span></div>
      <form className="price-alert-form" onSubmit={event => { event.preventDefault(); save(); }}>
        <label className="ticket-input"><span className="ticket-prefix">$</span><input className="num" inputMode="decimal" aria-label="Alert price" value={text} onChange={event => setText(event.target.value.replace(/[^0-9.]/g, ''))} /></label>
        <button className="btn btn-primary" type="submit" disabled={!valid}>Set alert</button>
      </form>
      <small className="price-alert-hint">{valid ? `When ${symbol} goes ${direction} ${price(target)}.` : 'Enter a price above or below the current one.'}</small>
      {watching.length > 0 && <div className="alerts-sub">{watching.map(a => <div key={a.id} className="alerts-watch">
        <span className="alerts-watch-name"><strong>{a.direction === 'above' ? 'Above' : 'Below'}</strong><small className="num">{price(a.price)}</small></span>
        <button className="icon-btn icon-btn--sm" aria-label="Remove alert" onClick={() => removePriceAlert(owner, a.id)}><X size={14} /></button>
      </div>)}</div>}
    </div>}
  </div>;
}
