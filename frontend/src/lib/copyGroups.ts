import type { ChatMessage, CopyOf } from './contracts';

// Copies of one trade read as one card ("You and 23 others copied 23daddy's
// SOL-PERP long 2x") instead of a notice per copier. Copies opening and
// copies closing are separate cards. Each card sits where its latest copy
// landed, so it moves down and grows as more people join.

const OPENED = /^(opened an automatic copy of |auto-copied |copied )/;
const CLOSED = /^(closed their automatic copy of |had already exited their automatic copy of )/;

export type CopyPhase = 'open' | 'close';
export type Copier = { id: string; name: string; avatarUrl: string | null };
export type CopyGroup = { key: string; phase: CopyPhase; copyOf: CopyOf; position: string; copiers: Copier[]; createdAt: string };

export function copyPhase(message: ChatMessage): CopyPhase | null {
  if (message.kind !== 'system' || !message.copyOf) return null;
  return OPENED.test(message.body) ? 'open' : CLOSED.test(message.body) ? 'close' : null;
}

// "SOL-PERP long" from "opened an automatic copy of SOL-PERP long", or
// "SOL-PERP long 2x" from "auto-copied 23daddy's SOL-PERP long 2x with $10.00".
export const copiedPosition = (body: string) =>
  body.replace(OPENED, '').replace(CLOSED, '').replace(/ with \$[\d.,]+$/, '').replace(/^.*?'s /, '').trim();

// The messages to show, minus the copy notices folded into a card, plus
// which remaining message (each group's latest) renders that card.
export function groupCopies<T extends ChatMessage>(messages: T[]): { shown: T[]; cards: Map<string, CopyGroup> } {
  const groups = new Map<string, CopyGroup>();
  const anchor = new Map<string, string>(); // group key -> id of its latest notice
  for (const message of messages) {
    const phase = copyPhase(message);
    if (!phase) continue;
    const key = `${message.copyOf!.markerId}:${phase}`;
    const group = groups.get(key) ?? { key, phase, copyOf: message.copyOf!, position: copiedPosition(message.body), copiers: [], createdAt: message.createdAt };
    if (!group.copiers.some(c => c.id === message.memberId)) group.copiers.push({ id: message.memberId, name: message.memberName, avatarUrl: message.memberAvatarUrl });
    group.createdAt = message.createdAt;
    groups.set(key, group);
    anchor.set(key, message.id);
  }
  const cards = new Map<string, CopyGroup>();
  for (const [key, id] of anchor) cards.set(id, groups.get(key)!);
  const shown = messages.filter(message => {
    const phase = copyPhase(message);
    return !phase || cards.has(message.id);
  });
  return { shown, cards };
}

// "You", "You and Ada", "You and 23 others": you first when you're in it.
export function copiersLabel(copiers: Copier[], meId?: string | null): string {
  const names = [...copiers].sort((a, b) => Number(b.id === meId) - Number(a.id === meId)).map(c => (meId && c.id === meId ? 'You' : c.name));
  if (names.length <= 1) return names[0] ?? 'Someone';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

export function copyCardText(group: CopyGroup, meId?: string | null): string {
  const who = copiersLabel(group.copiers, meId);
  const whose = meId && group.copyOf.leaderId === meId ? 'your' : `${group.copyOf.leaderName}'s`;
  if (group.phase === 'open') return `${who} copied ${whose} ${group.position}`;
  return `${who} closed ${group.copiers.length === 1 ? 'their copy' : 'their copies'} of ${whose} ${group.position}`;
}
