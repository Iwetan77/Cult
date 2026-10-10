import type { ChatMessage } from './contracts';

// Opening and closing are once-per-marker events. Adds and partial exits can
// legitimately repeat, and separate entries on the same asset have distinct IDs.
export function uniqueChatNotices<T extends ChatMessage>(messages: T[]): T[] {
  const seen = new Set<string>();
  return messages.filter(message => {
    if (message.kind !== 'system' || !/^(trade|mirror):/.test(message.markerId ?? '')) return true;
    const phase = /^(opened |bought \$)/.test(message.body) ? 'open'
      : /^(closed |sold all |had already exited their automatic copy of )/.test(message.body) ? 'close' : null;
    if (!phase) return true;
    const key = `${message.room}:${message.memberId}:${message.markerId}:${phase}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
