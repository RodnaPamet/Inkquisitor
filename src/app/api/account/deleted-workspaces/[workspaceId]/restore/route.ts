/**
 * POST /api/account/deleted-workspaces/:workspaceId/restore — one of its OWNERs brings back a deleted workspace,
 * whole, within 30 days (Phase 5.H-a, D36). Anyone else, or past the window, is a 404.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { getUserCtx } from '@/app-layer/context';
import { restoreWorkspace } from '@/app-layer/usecases/workspace-deletion';

type RouteContext = { params: Promise<{ workspaceId: string }> };

export const POST = withApiErrorHandling<RouteContext>(async (req: NextRequest, { params }) => {
    const ctx = await getUserCtx(req);
    const { workspaceId } = await params;
    return NextResponse.json(await restoreWorkspace(ctx, workspaceId));
});
