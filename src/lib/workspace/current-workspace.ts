/**
 * The workspace the current request belongs to — SERVER-SIDE.
 *
 * Replaces the 0.2 stub. Built from `getWorkspacePageCtx` (the session, then
 * a DATABASE membership check for the URL's slug): a visitor with no session
 * is sent to /login and a non-member to /no-workspace, so a page that gets a
 * value back is inside a workspace its viewer belongs to. The value is the
 * plain, serializable `WorkspaceContextValue` the client provider takes;
 * nothing secret is in it.
 *
 * Kept out of `workspace-context.tsx` on purpose: that module is
 * `'use client'`, and this one reads the session and the database.
 */
import type { WorkspaceContextValue } from './workspace-context';
import { getWorkspacePageCtx } from '@/app-layer/context';

export async function getCurrentWorkspace(workspaceSlug: string): Promise<WorkspaceContextValue> {
    const { ctx, workspaceName, userName } = await getWorkspacePageCtx(workspaceSlug);
    return {
        workspaceId: ctx.workspaceId,
        workspaceSlug: ctx.workspaceSlug,
        workspaceName,
        role: ctx.role,
        userId: ctx.userId,
        userName,
    };
}
