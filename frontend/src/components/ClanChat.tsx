'use client';

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { getAccessToken } from '@privy-io/react-auth';
import { Link2, Reply, Send, X } from 'lucide-react';
import { getClanMessages, sendClanMessage } from '@/lib/api';
import type { ChatMessage, ChartMarker } from '@/lib/contracts';

type Props = {
  clanId: string;
  liveMessage: ChatMessage | null;
  selectedMarker: ChartMarker | null;
  onOpenMarker: (markerId: string) => void;
};

const messageError = (error: unknown) => error instanceof Error ? error.message : 'Messages are unavailable.';

export function ClanChat({ clanId, liveMessage, selectedMarker, onOpenMarker }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
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
    setLoading(true);
    setReplyTo(null);
    setMarkerId(null);
    setUnread(0);
    stickToBottom.current = true;
    getAccessToken().then(accessToken => {
      if (!accessToken) throw new Error('Sign in again to read cult messages.');
      return getClanMessages(accessToken, clanId);
    }).then(page => {
      if (!active) return;
      setMessages(page.messages);
      setHasMore(page.hasMore);
      setError(null);
    }).catch(reason => { if (active) setError(messageError(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [clanId]);

  useEffect(() => {
    if (!liveMessage || liveMessage.clanId !== clanId) return;
    setMessages(current => current.some(item => item.id === liveMessage.id) ? current : [...current, liveMessage]);
    if (!stickToBottom.current) setUnread(count => count + 1);
  }, [liveMessage, clanId]);

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
      const page = await getClanMessages(accessToken, clanId, before);
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
      const message = await sendClanMessage(accessToken, clanId, body, replyTo?.id, markerId ?? undefined);
      stickToBottom.current = true;
      setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message]);
      setDraft('');
      setReplyTo(null);
      setMarkerId(null);
      setUnread(0);
    } catch (reason) { setError(messageError(reason)); }
    finally { setSending(false); }
  };

  const jumpToLatest = () => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
    stickToBottom.current = true;
    setUnread(0);
  };

  return <div className="detail-body chat-panel">
    <div className="detail-section-label">CULT</div>
    <h2>Clan chat</h2>
    <div className="chat-log" ref={listRef} onScroll={event => {
      const list = event.currentTarget;
      stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 50;
      if (stickToBottom.current) setUnread(0);
    }}>
      {hasMore && <button className="chat-older" disabled={loadingOlder} onClick={loadOlder}>{loadingOlder ? 'Loading...' : 'Older messages'}</button>}
      {loading ? <p className="field-note">Loading messages...</p> : messages.length === 0 ? <p className="field-note">No messages in this cult yet.</p> : messages.map(message => <div className="chat-message" key={message.id} id={'chat-message-' + message.id}>
        <div className="chat-meta"><strong>{message.memberName}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
        {message.replyTo && <div className="chat-reference"><Reply size={12} /> Reply to {messages.find(item => item.id === message.replyTo)?.memberName ?? 'message'}</div>}
        <p className="chat-text">{message.body}</p>
        <div className="chat-actions"><button title="Reply to message" onClick={() => setReplyTo(message)}><Reply size={13} /> Reply</button>{message.markerId && <button title="Show linked chart marker" onClick={() => onOpenMarker(message.markerId!)}><Link2 size={13} /> View trade</button>}</div>
      </div>)}
    </div>
    {unread > 0 && <button className="chat-latest" onClick={jumpToLatest}>{unread} new - Latest</button>}
    {error && <p className="wallet-warning" role="status">{error}</p>}
    <form className="chat-compose" onSubmit={send}>
      {replyTo && <div className="chat-context"><Reply size={13} /> Replying to {replyTo.memberName}<button type="button" title="Cancel reply" onClick={() => setReplyTo(null)}><X size={13} /></button></div>}
      {markerId && <div className="chat-context"><Link2 size={13} /> Linked trade<button type="button" title="Remove trade link" onClick={() => setMarkerId(null)}><X size={13} /></button></div>}
      {selectedMarker && !markerId && <button className="chat-attach" type="button" onClick={() => setMarkerId(selectedMarker.id)}><Link2 size={13} /> Link selected trade</button>}
      <textarea value={draft} onChange={event => setDraft(event.target.value)} maxLength={1000} rows={3} placeholder="Message your cult" aria-label="Message your cult" />
      <div className="chat-submit"><span>{draft.length}/1000</span><button className="primary" type="submit" disabled={sending || !draft.trim()}><Send size={14} /> Send</button></div>
    </form>
  </div>;
}
