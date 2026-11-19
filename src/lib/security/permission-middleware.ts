/**
 * Route-level permission enforcement for workspace API routes.
 *
 *   export const PATCH = withApiErrorHandling(
 *       requirePermission('members.manage', async (req, { params }, ctx) => {
 *           // ctx: the resolved WorkspaceRequestContext; the permission is held.
 *           return NextResponse.json(await changeMemberRole(ctx, …));
 *       }),
 *   );
 *
 * It resolves the context from the URL's `workspaceSlug` (`getWorkspaceCtx`:
 * session, then a DATABASE membership check — 401 without a session, 404 for a
 * workspace the caller does not belong to), then asks `assertPermission`, which
 * audits a denial as AUTHZ_DENIED and throws a generic 403. The handler gets
 * the context as its third argument.
 *
 * Permission-KEY driven, never role driven: `PermissionSet`
 * (src/lib/permissions.ts) decides what a role may do.
 *
 * Adapted from inflect-compliance's `src/lib/security/permission-middleware.ts`
 * (see docs/carve-manifest.md): one key per call, no API-key coarse tier.
 */
import type { NextRequest } from 'next/server';
import { getWorkspaceCtx } from '@/app-layer/context';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import type { PermissionKey } from '@/lib/permissions';

export type WorkspaceParams = { workspaceSlug: string };

export type PermissionedHandler<P extends WorkspaceParams> = (
    req: NextRequest,
    routeArgs: { params: P },
    ctx: WorkspaceRequestContext,
) => Promise<Response> | Response;

export type WorkspaceRouteHandler<P extends WorkspaceParams> = (req: NextRequest, routeArgs: { params: Promise<P> }) => Promise<Response>;

function safePath(req: NextRequest): string {
    try {
        return req.nextUrl.pathname;
    } catch {
        return '<unknown>';
    }
}

export function requirePermission<P extends WorkspaceParams = WorkspaceParams>(
    key: PermissionKey,
    handler: PermissionedHandler<P>,
): WorkspaceRouteHandler<P> {
    return async function permissionedRoute(req, routeArgs) {
        const params = await routeArgs.params;
        const ctx = await getWorkspaceCtx(params, req);
        await assertPermission(ctx, key, { method: req.method, path: safePath(req) });
        return handler(req, { params }, ctx);
    };
}
