/** The permission set each workspace role grants (owner decision D4). */
import { ALL_PERMISSION_KEYS, getPermissionsForRole, hasPermission } from '@/lib/permissions';

const grants = (role: 'OWNER' | 'EDITOR' | 'READER') => ALL_PERMISSION_KEYS.filter((k) => hasPermission(getPermissionsForRole(role), k));

it('OWNER holds every key', () => {
    expect(grants('OWNER')).toEqual(ALL_PERMISSION_KEYS);
});

it('EDITOR writes content but manages nothing and reads no audit trail', () => {
    expect(grants('EDITOR').sort()).toEqual(['content.edit', 'content.view', 'members.view', 'workspace.view']);
});

it('READER only reads', () => {
    expect(grants('READER').sort()).toEqual(['content.view', 'members.view', 'workspace.view']);
});

it('the table cannot be mutated through a returned set', () => {
    const p = getPermissionsForRole('READER');
    p.members.manage = true;
    expect(hasPermission(getPermissionsForRole('READER'), 'members.manage')).toBe(false);
});
