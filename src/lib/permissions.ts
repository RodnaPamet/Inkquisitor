/**
 * The permission set each workspace role grants (owner decision D4: OWNER,
 * EDITOR, READER).
 *
 * Permissions are KEYS, not roles: a route asks `requirePermission('members.manage')`
 * (`src/lib/security/permission-middleware.ts`), a usecase asks the same key
 * of `ctx.permissions`, and neither compares a role name. Adding a role, or a
 * custom role later, changes this table and nothing that reads it.
 *
 *   workspace.view     see the workspace                     all
 *   workspace.manage   rename, settings                      OWNER
 *   members.view       see who belongs                       all
 *   members.manage     invite, change a role, remove         OWNER
 *   bible.view         read books and their bibles           all
 *   bible.edit         write books, bible elements, fields,  OWNER, EDITOR
 *                      relations; restore a version
 *   audit.view         read the audit trail                  OWNER
 *
 * Adapted from inflect-compliance's `src/lib/permissions.ts` (see
 * docs/carve-manifest.md): the shape (a nested record of booleans, resolved
 * once per request from the role) is inflect's; the domains are Inkquisitor's.
 */
import type { WorkspaceRole } from '@/app-layer/types';

export interface PermissionSet {
    workspace: { view: boolean; manage: boolean };
    members: { view: boolean; manage: boolean };
    bible: { view: boolean; edit: boolean };
    audit: { view: boolean };
}

/** `'members.manage'`, … — every leaf of `PermissionSet`, compile-time exhaustive. */
export type PermissionKey = {
    [Domain in keyof PermissionSet]: `${Domain & string}.${keyof PermissionSet[Domain] & string}`;
}[keyof PermissionSet];

const ROLE_PERMISSIONS: Readonly<Record<WorkspaceRole, PermissionSet>> = {
    OWNER: {
        workspace: { view: true, manage: true },
        members: { view: true, manage: true },
        bible: { view: true, edit: true },
        audit: { view: true },
    },
    EDITOR: {
        workspace: { view: true, manage: false },
        members: { view: true, manage: false },
        bible: { view: true, edit: true },
        audit: { view: false },
    },
    READER: {
        workspace: { view: true, manage: false },
        members: { view: true, manage: false },
        bible: { view: true, edit: false },
        audit: { view: false },
    },
};

/** A fresh copy, so a caller cannot mutate the table. */
export function getPermissionsForRole(role: WorkspaceRole): PermissionSet {
    return structuredClone(ROLE_PERMISSIONS[role]);
}

export function hasPermission(permissions: PermissionSet, key: PermissionKey): boolean {
    const [domain, action] = key.split('.') as [keyof PermissionSet, string];
    const bag = permissions[domain] as Record<string, boolean> | undefined;
    return bag?.[action] === true;
}

/** Every key, for tests and for the permission table in the docs. */
export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = (
    Object.entries(ROLE_PERMISSIONS.OWNER) as Array<[keyof PermissionSet, Record<string, boolean>]>
).flatMap(([domain, bag]) => Object.keys(bag).map((action) => `${domain}.${action}` as PermissionKey));
