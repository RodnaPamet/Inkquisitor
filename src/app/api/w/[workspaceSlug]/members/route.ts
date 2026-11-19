/** GET /api/w/:workspaceSlug/members — the workspace's members (`members.view`). */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listMembers } from '@/app-layer/usecases/members';

export const GET = withApiErrorHandling(
    requirePermission('members.view', async (_req, _args, ctx) => NextResponse.json({ members: await listMembers(ctx) })),
);
