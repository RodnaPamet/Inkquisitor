/**
 * The one authorization check: does the context's permission set hold `key`?
 *
 * A denial writes an AUTHZ_DENIED row to the workspace's audit trail (the
 * key, the role, the method and path — never a body) and THEN throws a
 * generic `ForbiddenError('Permission denied')`: the response names no key,
 * so a caller cannot map the permission namespace, while the trail keeps the
 * detail for the owner. FAIL-CLOSED: if the row cannot be written the write's
 * error propagates and the caller gets a 500, never a silent 403 with a gap in
 * the trail.
 *
 * Called by `requirePermission` (src/lib/security/permission-middleware.ts) at
 * the route, and by usecases as their own policy check, so a usecase reached
 * some other way still refuses — and still records the refusal.
 *
 * Adapted from inflect-compliance's `assertPermission` /
 * `auditPermissionDenied` (src/lib/security/assert-permission.ts; see
 * docs/carve-manifest.md), without the outbox.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { ForbiddenError } from '@/lib/errors/types';
import { hasPermission, type PermissionKey } from '@/lib/permissions';

export interface DenialSite {
    method?: string;
    path?: string;
}

export async function assertPermission(ctx: WorkspaceRequestContext, key: PermissionKey, site: DenialSite = {}): Promise<void> {
    if (hasPermission(ctx.permissions, key)) return;
    await denyPermission(ctx, key, site);
}

/**
 * Record the refusal (AUTHZ_DENIED, in a transaction of its own so it survives
 * the caller's rollback) and throw the generic 403. `extra` carries codes only,
 * e.g. the role the database holds NOW when it no longer matches the context's.
 */
export async function denyPermission(
    ctx: WorkspaceRequestContext,
    key: PermissionKey,
    site: DenialSite = {},
    extra: Record<string, string | null> = {},
): Promise<never> {
    await logEvent(ctx, {
        action: 'AUTHZ_DENIED',
        entityType: 'Permission',
        entityId: null,
        details: {
            permission: key,
            role: ctx.role,
            ...(site.method ? { method: site.method } : {}),
            ...(site.path ? { path: site.path } : {}),
            ...extra,
        },
    });
    throw new ForbiddenError('Permission denied');
}
