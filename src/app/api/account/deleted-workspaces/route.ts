/**
 * GET /api/account/deleted-workspaces — the signed-in person's deleted workspaces they are an OWNER of and may still
 * restore (Phase 5.H-a, D36). Self-service (`getUserCtx`): a deleted workspace has no context to enter.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { getUserCtx } from '@/app-layer/context';
import { listRestorableWorkspaces } from '@/app-layer/usecases/workspace-deletion';

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    return NextResponse.json(await listRestorableWorkspaces(ctx));
});
