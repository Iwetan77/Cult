import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canManageCultMember, cultMemberRole } from '../src/lib/cultRoles';

test('a creator is labelled owner even if an old admin flag is false', () => {
  assert.equal(cultMemberRole({ id: 'creator', owner: true, admin: false }, { isOwner: false }, 'admin'), 'owner');
  assert.equal(cultMemberRole({ id: 'creator', admin: true }, { isOwner: true }, 'creator'), 'owner');
});

test('admins never get a remove-admin action for the owner', () => {
  assert.equal(canManageCultMember({ isOwner: false, isAdmin: true }, { id: 'creator', owner: true, admin: true }, 'admin'), false);
  assert.equal(canManageCultMember({ isOwner: true, isAdmin: true }, { id: 'creator', owner: true, admin: true }, 'creator'), false);
});

test('ordinary role controls remain available only to admins and owners', () => {
  const member = { id: 'member', owner: false, admin: false };
  assert.equal(canManageCultMember({ isOwner: false, isAdmin: false }, member, 'viewer'), false);
  assert.equal(canManageCultMember({ isOwner: false, isAdmin: true }, member, 'admin'), true);
  assert.equal(canManageCultMember({ isOwner: true }, member, 'creator'), true);
  assert.equal(canManageCultMember({ isOwner: false, isAdmin: true }, member, 'member'), false);
  assert.equal(cultMemberRole(member, { isOwner: false }, 'viewer'), 'member');
  assert.equal(cultMemberRole({ ...member, admin: true }, { isOwner: false }, 'viewer'), 'admin');
});
