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

test('only owners get promotion and demotion controls for other members', () => {
  const member = { id: 'member', owner: false, admin: false };
  for (const admin of [false, true]) {
    const target = { ...member, admin };
    assert.equal(canManageCultMember({ isOwner: false, isAdmin: false }, target, 'viewer'), false);
    assert.equal(canManageCultMember({ isOwner: false, isAdmin: true }, target, 'admin'), false);
    assert.equal(canManageCultMember({ isOwner: true }, target, 'creator'), true);
    assert.equal(canManageCultMember({ isOwner: true, isAdmin: false }, target, 'creator'), true);
    assert.equal(canManageCultMember({ isOwner: true }, target, undefined), false);
    assert.equal(canManageCultMember({ isOwner: false, isAdmin: true }, target, 'member'), false);
  }
  assert.equal(cultMemberRole(member, { isOwner: false }, 'viewer'), 'member');
  assert.equal(cultMemberRole({ ...member, admin: true }, { isOwner: false }, 'viewer'), 'admin');
});
