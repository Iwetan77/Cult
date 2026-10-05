'use client';

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { getAccessToken } from '@/lib/auth';
import { isDemo } from '@/lib/demo';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { ArrowDown, ArrowRight, CandlestickChart, Link2, Pin, Reply, RotateCcw, Send, X } from './icons';
import { getRoomEventUrl, getRoomMessages, pinRoomMessage, sendRoomMessage } from '@/lib/api';
import type { ChatMessage, ChatPage, ChatRoom, ChartMarker } from '@/lib/contracts';
import { dollars, signedDollars } from '@/lib/format';
import { Avatar } from './Avatar';
import { RoomBadge } from './RoomBadge';
import { TokenLogo } from './TokenLogo';

type Props = {
  room: ChatRoom;
  liveMessage: ChatMessage | null;
  selectedMarker: ChartMarker | null;
  onOpenMarker: (markerId: string) => void;
  onMember: (memberId: string) => void;
  onActivity: () => void;
  onInvite?: () => void;
  canPin?: boolean;
  meId?: string;
  markers?: ChartMarker[]; // the cult's open positions, for live PnL on trade notices
  onTrade?: () => void;
  headerExtra?: React.ReactNode;
};

// A message as shown: sent ones, plus ours still on their way (or failed).
type Shown = ChatMessage & { local?: 'sending' | 'failed' };

const messageError = (error: unknown) => error instanceof Error ? error.message : 'Messages are unavailable.';
const GROUP_MS = 5 * 60_000;
const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// "opened BTC-PERP long 5x", "bought $MOE", "sold 50% of $MOE", "closed ..."
function readTrade(body: string): { symbol: string; tone: 'long' | 'short' | 'buy' | 'sell' | 'closed' } | null {
  const symbol = body.match(/[A-Z0-9]+-PERP|\$[A-Za-z0-9_.]+/)?.[0];
  if (!symbol) return null;
  if (/^(closed|sold all)\b/.test(body)) return { symbol, tone: 'closed' };
  if (/^sold\b/.test(body)) return { symbol, tone: 'sell' };
  if (/\bshort\b/.test(body)) return { symbol, tone: 'short' };
  if (/\blong\b/.test(body)) return { symbol, tone: 'long' };
  return { symbol, tone: 'buy' };
}

export function ClanChat({ room, liveMessage, selectedMarker, onOpenMarker, onMember, onActivity, onInvite, canPin = false, meId, markers = [], onTrade, headerExtra }: Props) {
  const [messages, setMessages] = useState<Shown[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [pinned, setPinned] = useState<ChatPage['pinned']>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [markerId, setMarkerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  const prependPosition = useRef<{ height: number; top: number } | null>(null);

  useEffect(() => {
    let active = true;
    setMessages([]);
    setHasMore(false);
    setPinned(null);
    setLoading(true);
    setReplyTo(null);
    setMarkerId(null);
    setUnread(0);
    stickToBottom.current = true;
    getAccessToken().then(accessToken => {
      if (!accessToken) throw new Error('Sign in again to read messages.');
      return getRoomMessages(accessToken, room.id);
    }).then(page => {
      if (!active) return;
      setMessages(page.messages);
      setHasMore(page.hasMore);
      setPinned(page.pinned);
      setError(null);
    }).catch(reason => { if (active) setError(messageError(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [room.id]);

  const receive = (incoming: ChatMessage) => {
    setMessages(current => current.some(item => item.id === incoming.id) ? current : [...current, incoming]);
    if (!stickToBottom.current) setUnread(count => count + 1);
    onActivity();
  };
  const receiveRef = useRef(receive);
  receiveRef.current = receive;

  useEffect(() => {
    if (!liveMessage || liveMessage.room !== room.id) return;
    receiveRef.current(liveMessage);
  }, [liveMessage, room.id]);

  useEffect(() => {
    if (room.kind === 'cult' || isDemo()) return;
    const controller = new AbortController();
    class StopStream extends Error {}
    void fetchEventSource(getRoomEventUrl(room.id), {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
      fetch: async (input, init) => {
        const token = await getAccessToken();
        if (!token) throw new StopStream('Sign in again to receive messages.');
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${token}`);
        return fetch(input, { ...init, headers });
      },
      onopen: async response => {
        if (response.status === 401 || response.status === 403) throw new StopStream('Room access is unavailable.');
        if (response.status === 429) {
          const seconds = Number(response.headers.get('Retry-After'));
          throw new StopStream(Number.isFinite(seconds) && seconds > 0 ? `Slow down, try again in ${Math.ceil(seconds)}s.` : 'Slow down, try again shortly.');
        }
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Live messages are unavailable.');
      },
      onmessage: event => {
        if (event.event !== 'message') return;
        try {
          const incoming = JSON.parse(event.data) as ChatMessage;
          if (incoming.room !== room.id || typeof incoming.id !== 'string' || typeof incoming.body !== 'string') return;
          receiveRef.current(incoming);
        } catch { /* Ignore malformed messages. */ }
      },
      onclose: () => { throw new Error('Live messages disconnected.'); },
      onerror: error => {
        if (error instanceof StopStream) throw error;
        return 3000;
      },
    }).catch(reason => { if (!controller.signal.aborted) setError(messageError(reason)); });
    return () => controller.abort();
  }, [room.id, room.kind]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (prependPosition.current) {
      list.scrollTop = list.scrollHeight - prependPosition.current.height + prependPosition.current.top;
      prependPosition.current = null;
    } else if (stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [messages]);

  const loadOlder = async () => {
    const before = messages.find(item => !item.local)?.id;
    if (!before || !hasMore || loadingOlder) return;
    setLoadingOlder(true);
    setError(null);
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error('Sign in again to read messages.');
      const page = await getRoomMessages(accessToken, room.id, before);
      const list = listRef.current;
      if (list) prependPosition.current = { height: list.scrollHeight, top: list.scrollTop };
      setMessages(current => [...page.messages.filter(item => !current.some(existing => existing.id === item.id)), ...current]);
      setHasMore(page.hasMore);
    } catch (reason) { setError(messageError(reason)); }
    finally { setLoadingOlder(false); }
  };

  // Shown straight away, confirmed (or marked failed) when the server answers.
  const deliver = async (local: Shown) => {
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error('Sign in again to send a message.');
      const sent = await sendRoomMessage(accessToken, room.id, local.body, local.replyTo ?? undefined, local.markerId ?? undefined);
      setMessages(current => {
        const withoutLocal = current.filter(item => item.id !== local.id);
        return withoutLocal.some(item => item.id === sent.id) ? withoutLocal : [...withoutLocal, sent];
      });
      onActivity();
    } catch (reason) {
      setMessages(current => current.map(item => item.id === local.id ? { ...item, local: 'failed' } : item));
      setError(messageError(reason));
    }
  };
  const send = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || body.length > 1000) return;
    const local: Shown = {
      id: `local:${Date.now()}`, room: room.id, kind: 'text', clanId: null, memberId: meId ?? 'me', memberName: 'You', memberAvatarUrl: null,
      body, text: body, replyTo: replyTo?.id ?? null, markerId, createdAt: new Date().toISOString(), local: 'sending',
    };
    stickToBottom.current = true;
    setMessages(current => [...current, local]);
    setDraft('');
    setReplyTo(null);
    setMarkerId(null);
    setUnread(0);
    setError(null);
    void deliver(local);
    inputRef.current?.focus();
  };
  const retry = (message: Shown) => {
    setMessages(current => current.map(item => item.id === message.id ? { ...item, local: 'sending' } : item));
    void deliver(message);
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
  };

  const togglePin = async (messageId: string | null) => {
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error('Sign in again to pin messages.');
      const result = await pinRoomMessage(accessToken, room.id, messageId);
      setPinned(result.pinned);
    } catch (reason) { setError(messageError(reason)); }
  };

  const jumpToLatest = () => {
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    stickToBottom.current = true;
    setUnread(0);
  };

  // Auto-grow the composer up to a few lines.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  }, [draft]);

  const tradeCard = (message: Shown) => {
    const trade = readTrade(message.body);
    const live = message.markerId ? markers.find(item => item.id === message.markerId) : undefined;
    if (!trade) return <div className="chat-notice" key={message.id}><span><strong>{message.memberName}</strong> {message.body}</span><time>{time(message.createdAt)}</time></div>;
    return <div className="chat-trade" key={message.id}>
      <TokenLogo symbol={trade.symbol} />
      <div className="chat-trade-main">
        <span><button className="chat-name" onClick={() => onMember(message.memberId)}>{message.memberId === meId ? 'You' : message.memberName}</button> {message.body}</span>
        <small><span className={`side-chip ${trade.tone === 'sell' ? 'short' : trade.tone}`}>{trade.tone.toUpperCase()}</span>{live ? <b className={live.venue === 'perpl' ? ((live.pnlUsd ?? 0) >= 0 ? 'positive' : 'negative') : ''}>{live.venue === 'perpl' ? (live.pnlUsd == null ? 'Pending' : `${signedDollars(live.pnlUsd)} live`) : live.valueUsd == null ? '' : `${dollars(live.valueUsd)} now`}</b> : null}<time>{time(message.createdAt)}</time></small>
      </div>
      {message.markerId && <button className="chat-trade-open" onClick={() => onOpenMarker(message.markerId!)}>View on chart <ArrowRight size={13} /></button>}
    </div>;
  };

  return <div className="chat">
    <div className="chat-room-heading">
      <RoomBadge icon={room.icon} kind={room.kind} size="lg" />
      <div><h2>{room.name}</h2><small>{room.memberCount} {room.memberCount === 1 ? 'member' : 'members'}{room.kind === 'cult' ? ' · trades post here' : ''}</small></div>
      <div className="chat-head-tools">{headerExtra}{room.kind === 'cult' && onInvite && <button className="btn btn-ghost btn-sm" onClick={onInvite}><Link2 size={14} /> Invite</button>}</div>
    </div>
    {pinned && <div className="chat-pinned"><Pin size={14} /><span><strong>{pinned.memberName}</strong> {pinned.body}</span>{canPin && <button className="icon-btn icon-btn--sm" title="Unpin message" onClick={() => void togglePin(null)}><X size={13} /></button>}</div>}
    <div className="chat-log" ref={listRef} onScroll={event => {
      const list = event.currentTarget;
      stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
      if (stickToBottom.current) setUnread(0);
    }}>
      {hasMore && <button className="chat-older" disabled={loadingOlder} onClick={loadOlder}>{loadingOlder ? 'Loading…' : 'Older messages'}</button>}
      {loading ? <div className="chat-loading">{Array.from({ length: 5 }, (_, i) => <span key={i} className={i % 2 ? 'mine' : ''} />)}</div>
        : messages.length === 0 ? <div className="chat-empty"><RoomBadge icon={room.icon} kind={room.kind} size="lg" /><strong>Say hi to {room.name}</strong><span>{room.kind === 'cult' ? 'Tell your cult what you are about to trade. Trades post here on their own.' : 'Everyone here can see what you post.'}</span></div>
        : messages.map((message, index) => {
          const prev = messages[index - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
          const separator = newDay && <div className="chat-day"><span>{dayLabel(message.createdAt)}</span></div>;
          if (message.kind === 'system') return <Fragment key={message.id}>{separator}{tradeCard(message)}</Fragment>;
          const mine = (!!meId && message.memberId === meId) || message.local != null;
          const grouped = !newDay && prev && prev.kind === 'text' && prev.memberId === message.memberId && Date.parse(message.createdAt) - Date.parse(prev.createdAt) < GROUP_MS;
          const quoted = message.replyTo ? messages.find(item => item.id === message.replyTo) : null;
          return <Fragment key={message.id}>{separator}<div className={`chat-row ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}`} id={'chat-message-' + message.id}>
            {!mine && (grouped ? <span className="chat-avatar-space" /> : <button className="chat-avatar" onClick={() => onMember(message.memberId)} title={message.memberName}><Avatar name={message.memberName} url={message.memberAvatarUrl} /></button>)}
            <div className="chat-bubble-wrap">
              {!mine && !grouped && <button className="chat-name" onClick={() => onMember(message.memberId)}>{message.memberName}</button>}
              <div className={`chat-bubble ${message.local ?? ''}`}>
                {quoted && <div className="chat-quote"><Reply size={11} /> <strong>{quoted.memberName}</strong> {quoted.body.slice(0, 80)}</div>}
                <p>{message.text}</p>
                <span className="chat-bubble-meta">{message.local === 'sending' ? 'Sending…' : message.local === 'failed' ? <button onClick={() => retry(message)}><RotateCcw size={11} /> Retry</button> : time(message.createdAt)}</span>
              </div>
              {!message.local && <div className="chat-actions"><button title="Reply" onClick={() => { setReplyTo(message); inputRef.current?.focus(); }}><Reply size={13} /></button>{message.markerId && <button title="View trade on chart" onClick={() => onOpenMarker(message.markerId!)}><Link2 size={13} /></button>}{canPin && <button title="Pin message" onClick={() => void togglePin(message.id)}><Pin size={13} /></button>}</div>}
            </div>
          </div></Fragment>;
        })}
    </div>
    {unread > 0 && <button className="chat-latest" onClick={jumpToLatest}><ArrowDown size={13} /> {unread} new {unread === 1 ? 'message' : 'messages'}</button>}
    {error && <p className="notice-line chat-error" role="status">{error}</p>}
    <form className="chat-compose" onSubmit={send}>
      {(replyTo || markerId) && <div className="chat-contexts">
        {replyTo && <div className="chat-context"><Reply size={13} /> Replying to {replyTo.memberName}<button type="button" title="Cancel reply" onClick={() => setReplyTo(null)}><X size={13} /></button></div>}
        {markerId && <div className="chat-context"><Link2 size={13} /> Linked trade<button type="button" title="Remove trade link" onClick={() => setMarkerId(null)}><X size={13} /></button></div>}
      </div>}
      <div className="chat-compose-row">
        {room.kind === 'cult' && selectedMarker && !markerId && <button className="icon-btn chat-attach" type="button" title="Link the selected trade" onClick={() => setMarkerId(selectedMarker.id)}><Link2 size={16} /></button>}
        <textarea ref={inputRef} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKey} maxLength={1000} rows={1} placeholder={`Message ${room.name}`} aria-label={`Message ${room.name}`} />
        <button className="chat-send" type="submit" title="Send" disabled={!draft.trim()}><Send size={16} /></button>
      </div>
      {(onTrade || (room.kind === 'cult' && onInvite)) && <div className="chat-tools">
        {onTrade && <button type="button" className="chat-tool" onClick={onTrade}><CandlestickChart size={14} /> Trade</button>}
        {room.kind === 'cult' && onInvite && <button type="button" className="chat-tool" onClick={onInvite}><Link2 size={14} /> Invite</button>}
        <span className="chat-hint">Enter to send · Shift+Enter for a new line</span>
      </div>}
    </form>
  </div>;
}
