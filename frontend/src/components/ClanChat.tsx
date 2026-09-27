'use client';

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { getAccessToken } from '@privy-io/react-auth';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { Link2, Pin, Reply, Send, X } from 'lucide-react';
import { getRoomEventUrl, getRoomMessages, pinRoomMessage, sendRoomMessage } from '@/lib/api';
import type { ChatMessage, ChatPage, ChatRoom, ChartMarker } from '@/lib/contracts';
import { Avatar } from './Avatar';

type Props = {
  room: ChatRoom;
  liveMessage: ChatMessage | null;
  selectedMarker: ChartMarker | null;
  onOpenMarker: (markerId: string) => void;
  onMember: (memberId: string) => void;
  onActivity: () => void;
  onInvite?: () => void;
  canPin?: boolean;
};

const messageError = (error: unknown) => error instanceof Error ? error.message : 'Messages are unavailable.';

export function ClanChat({ room, liveMessage, selectedMarker, onOpenMarker, onMember, onActivity, onInvite, canPin = false }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [pinned, setPinned] = useState<ChatPage['pinned']>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [markerId, setMarkerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
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
      if (!accessToken) throw new Error('Sign in again to read cult messages.');
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

  useEffect(() => {
    if (!liveMessage || liveMessage.room !== room.id) return;
    setMessages(current => current.some(item => item.id === liveMessage.id) ? current : [...current, liveMessage]);
    if (!stickToBottom.current) setUnread(count => count + 1);
    onActivity();
  }, [liveMessage, room.id, onActivity]);

  useEffect(() => {
    if (room.kind === 'cult') return;
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
          setMessages(current => current.some(item => item.id === incoming.id) ? current : [...current, incoming]);
          if (!stickToBottom.current) setUnread(count => count + 1);
          onActivity();
        } catch { /* Ignore malformed messages. */ }
      },
      onclose: () => { throw new Error('Live messages disconnected.'); },
      onerror: error => {
        if (error instanceof StopStream) throw error;
        return 3000;
      },
    }).catch(reason => { if (!controller.signal.aborted) setError(messageError(reason)); });
    return () => controller.abort();
  }, [room.id, room.kind, onActivity]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (prependPosition.current) {
      list.scrollTop = list.scrollHeight - prependPosition.current.height + prependPosition.current.top;
      prependPosition.current = null;
    } else if (stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [messages]);

  const loadOlder = async () => {
    const before = messages[0]?.id;
    if (!before || !hasMore || loadingOlder) return;
    setLoadingOlder(true);
    setError(null);
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error('Sign in again to read cult messages.');
      const page = await getRoomMessages(accessToken, room.id, before);
      const list = listRef.current;
      if (list) prependPosition.current = { height: list.scrollHeight, top: list.scrollTop };
      setMessages(current => [...page.messages.filter(item => !current.some(existing => existing.id === item.id)), ...current]);
      setHasMore(page.hasMore);
    } catch (reason) { setError(messageError(reason)); }
    finally { setLoadingOlder(false); }
  };

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || body.length > 1000 || sending) return;
    setSending(true);
    setError(null);
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error('Sign in again to send a message.');
      const message = await sendRoomMessage(accessToken, room.id, body, replyTo?.id, markerId ?? undefined);
      stickToBottom.current = true;
      setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message]);
      setDraft('');
      setReplyTo(null);
      setMarkerId(null);
      setUnread(0);
      onActivity();
    } catch (reason) { setError(messageError(reason)); }
    finally { setSending(false); }
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
    if (list) list.scrollTop = list.scrollHeight;
    stickToBottom.current = true;
    setUnread(0);
  };

  return <div className="detail-body chat-panel">
    <div className="chat-room-heading"><div><span className="detail-section-label">{room.kind.toUpperCase()} CHAT</span><h2>{room.name}</h2><small>{room.memberCount} members</small></div>{room.kind === 'cult' && onInvite && <button className="outline" onClick={onInvite}><Link2 size={14} /> Invite</button>}</div>
    {pinned && <div className="chat-pinned"><Pin size={14} /><span><strong>{pinned.memberName}</strong> {pinned.body}</span>{canPin && <button className="icon-button compact" title="Unpin message" onClick={() => void togglePin(null)}><X size={13} /></button>}</div>}
    <div className="chat-log" ref={listRef} onScroll={event => {
      const list = event.currentTarget;
      stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 50;
      if (stickToBottom.current) setUnread(0);
    }}>
      {hasMore && <button className="chat-older" disabled={loadingOlder} onClick={loadOlder}>{loadingOlder ? 'Loading...' : 'Older messages'}</button>}
      {loading ? <p className="field-note">Loading messages...</p> : messages.length === 0 ? <p className="field-note">No messages in this room yet.</p> : messages.map(message => message.kind === 'system' ? <div className="chat-system-wrap" key={message.id}>{message.markerId ? <button className="chat-system" onClick={() => onOpenMarker(message.markerId!)}>{message.text} <Link2 size={13} /></button> : <span className="chat-system">{message.text}</span>}</div> : <div className="chat-message" key={message.id} id={'chat-message-' + message.id}>
        <Avatar name={message.memberName} url={message.memberAvatarUrl} /><div className="chat-message-main"><div className="chat-meta"><button onClick={() => onMember(message.memberId)}><strong>{message.memberName}</strong></button><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
        {message.replyTo && <div className="chat-reference"><Reply size={12} /> Reply to {messages.find(item => item.id === message.replyTo)?.memberName ?? 'message'}</div>}
        <p className="chat-text">{message.text}</p>
        <div className="chat-actions"><button title="Reply to message" onClick={() => setReplyTo(message)}><Reply size={13} /> Reply</button>{message.markerId && <button title="Show linked chart marker" onClick={() => onOpenMarker(message.markerId!)}><Link2 size={13} /> View trade</button>}{canPin && <button title="Pin message" onClick={() => void togglePin(message.id)}><Pin size={13} /> Pin</button>}</div></div>
      </div>)}
    </div>
    {unread > 0 && <button className="chat-latest" onClick={jumpToLatest}>{unread} new - Latest</button>}
    {error && <p className="wallet-warning" role="status">{error}</p>}
    <form className="chat-compose" onSubmit={send}>
      {replyTo && <div className="chat-context"><Reply size={13} /> Replying to {replyTo.memberName}<button type="button" title="Cancel reply" onClick={() => setReplyTo(null)}><X size={13} /></button></div>}
      {markerId && <div className="chat-context"><Link2 size={13} /> Linked trade<button type="button" title="Remove trade link" onClick={() => setMarkerId(null)}><X size={13} /></button></div>}
      {room.kind === 'cult' && selectedMarker && !markerId && <button className="chat-attach" type="button" onClick={() => setMarkerId(selectedMarker.id)}><Link2 size={13} /> Link selected trade</button>}
      <textarea value={draft} onChange={event => setDraft(event.target.value)} maxLength={1000} rows={3} placeholder={`Message ${room.name}`} aria-label={`Message ${room.name}`} />
      <div className="chat-submit"><span>{draft.length}/1000</span><button className="primary" type="submit" disabled={sending || !draft.trim()}><Send size={14} /> Send</button></div>
    </form>
  </div>;
}
