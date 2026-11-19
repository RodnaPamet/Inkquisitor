/**
 * Building the authorization context (`RequestContext`) for a request.
 *
 *   getUserCtx(req?)                 a signed-in person, no workspace (account routes:
 *                                    their own sessions). 401 without a session.
 *   getWorkspaceCtx(params, req?)    a signed-in person acting in the workspace the URL
 *                                    names. The membership is checked against the
 *                                    DATABASE — the JWT's claims are only the edge's
 *                                    fast path — and the context carries the role's
 *                                    permission set. A workspace that does not exist and
 *                                    one the person does not belong to are the SAME 404,
 *                                    so a non-member cannot probe which slugs exist.
 *   getWorkspacePageCtx(slug)        the page variant: no session → /login, not a member
 *                                    → /no-workspace, instead of throwing.
 *
 * The context is threaded EXPLICITLY into usecases as their first argument;
 * there is no AsyncLocalStorage for it. The session comes from
 * `getServerSession`, which runs the `jwt` callback, so a revoked session is
 * already `null` here (src/lib/auth/session-revoked.ts).
 *
 * Adapted from inflect-compliance's `src/app-layer/context.ts` (see
 * docs/carve-manifest.md): tenants → workspaces; API keys, SSO scope, Entra,
 * MFA and org contexts dropped.
 */
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { NotFoundError, UnauthorizedError } from '@/lib/errors/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { mergeRequestContext } from '@/lib/observability/context';
import { logger } from '@/lib/observability/logger';
import { MembershipRepository } from './repositories/membership.repository';
import type { RequestContext, WorkspaceRequestContext, WorkspaceRole } from './types';

const REQUEST_ID_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;

function requestIdOf(req?: NextRequest): string {
    const offered = req?.headers.get('x-request-id');
    return offered && REQUEST_ID_SHAPE.test(offered) ? offered : randomUUID();
}

/** A signed-in person, no workspace. */
export type UserRequestContext = RequestContext & { userId: string };

export interface SessionUser {
    userId: string;
    email: string;
    name: string | null;
}

/** The signed-in person, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
    const session = await auth();
    const id = session?.user?.id;
    if (!id) return null;
    return { userId: id, email: session.user.email, name: session.user.name ?? null };
}

export async function getUserCtx(req?: NextRequest): Promise<UserRequestContext> {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError('Sign in to continue.');
    mergeRequestContext({ userId: user.userId });
    return { requestId: requestIdOf(req), userId: user.userId };
}

export interface ResolvedWorkspace {
    workspaceId: string;
    workspaceSlug: string;
    workspaceName: string;
    role: WorkspaceRole;
}

/** The workspace `slug` names and `userId`'s role in it, from the database; null when either is missing. */
export async function resolveWorkspaceMembership(userId: string, slug: string): Promise<ResolvedWorkspace | null> {
    if (!slug) return null;
    const row = await runWithoutRls({ reason: 'workspace-discovery' }, (db) => MembershipRepository.findForGate(db, slug, userId));
    const membership = row?.memberships[0];
    if (!row || !membership) return null;
    return { workspaceId: row.id, workspaceSlug: row.slug, workspaceName: row.name, role: membership.role };
}

type SlugParams = { workspaceSlug: string };

export async function getWorkspaceCtx(
    params: SlugParams | Promise<SlugParams>,
    req?: NextRequest,
): Promise<WorkspaceRequestContext> {
    const { workspaceSlug } = await params;
    const requestId = requestIdOf(req);
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError('Sign in to continue.');
    const resolved = await resolveWorkspaceMembership(user.userId, workspaceSlug);
    if (!resolved) {
        logger.warn('workspace-ctx.access_denied', { component: 'workspace-ctx', requestId });
        throw new NotFoundError('Workspace not found or access not permitted.');
    }
    mergeRequestContext({ userId: user.userId, workspaceId: resolved.workspaceId });
    return {
        requestId,
        userId: user.userId,
        workspaceId: resolved.workspaceId,
        workspaceSlug: resolved.workspaceSlug,
        role: resolved.role,
        permissions: getPermissionsForRole(resolved.role),
    };
}

/** The page variant: the context, plus the names the shell shows. Redirects instead of throwing. */
export async function getWorkspacePageCtx(
    workspaceSlug: string,
): Promise<{ ctx: WorkspaceRequestContext; workspaceName: string; userName: string | null }> {
    const user = await getSessionUser();
    if (!user) redirect(`/login?callbackUrl=${encodeURIComponent(`/w/${workspaceSlug}`)}`);
    const resolved = await resolveWorkspaceMembership(user.userId, workspaceSlug);
    if (!resolved) redirect('/no-workspace');
    mergeRequestContext({ userId: user.userId, workspaceId: resolved.workspaceId });
    return {
        ctx: {
            requestId: randomUUID(),
            userId: user.userId,
            workspaceId: resolved.workspaceId,
            workspaceSlug: resolved.workspaceSlug,
            role: resolved.role,
            permissions: getPermissionsForRole(resolved.role),
        },
        workspaceName: resolved.workspaceName,
        userName: user.name,
    };
}

/** The slug of the user's first workspace (oldest membership), or null when they have none. */
export async function firstWorkspaceSlug(userId: string): Promise<string | null> {
    const rows = await runWithoutRls({ reason: 'workspace-discovery' }, (db) => MembershipRepository.listForUser(db, userId, 1));
    return rows[0]?.workspace.slug ?? null;
}
