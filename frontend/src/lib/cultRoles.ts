import type { Clan, Member } from './contracts';

export function cultMemberRole(member: Pick<Member, 'id' | 'owner' | 'admin'>, cult: Pick<Clan, 'isOwner'>, viewerId: string | undefined): 'owner' | 'admin' | 'member' {
  if (member.owner || (cult.isOwner && member.id === viewerId)) return 'owner';
  return member.admin ? 'admin' : 'member';
}

export function canManageCultMember(cult: Pick<Clan, 'isOwner' | 'isAdmin'>, member: Pick<Member, 'id' | 'owner' | 'admin'>, viewerId: string | undefined): boolean {
  return !!viewerId && !!(cult.isOwner || cult.isAdmin) && member.id !== viewerId && cultMemberRole(member, cult, viewerId) !== 'owner';
}
