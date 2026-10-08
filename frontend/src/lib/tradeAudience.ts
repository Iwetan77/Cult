type CultAudience = { id: string; name: string; isOwner: boolean; isAdmin?: boolean };

export function tradeAudienceNotice(cults: CultAudience[], selected?: string[]): string {
  const eligible = cults.filter(cult => cult.isAdmin ?? cult.isOwner);
  const audience = selected === undefined ? eligible : eligible.filter(cult => selected.includes(cult.id));
  if (!audience.length) return 'Not posted to a cult.';
  if (audience.length === 1) return `Posted to ${audience[0]!.name}.`;
  return `Posted to ${audience.length} cults.`;
}
