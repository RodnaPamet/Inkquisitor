/**
 * POST /api/w/:workspaceSlug/deletion — an OWNER asks for the whole workspace to be deleted (`workspace.delete`,
 * Phase 5.H-a, D36). Body: `{ confirmName, deleteAccount? }`. Soft for 30 days (an OWNER restores it from their
 * account), then purged with everything it holds. Answers when it stops being restorable.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { requestWorkspaceDeletion } from '@/app-layer/usecases/workspace-deletion';

export const POST = withApiErrorHandling(requirePermission('workspace.delete', async (req, _args, ctx) => NextResponse.json(await requestWorkspaceDeletion(ctx, await readJsonBody(req)))));
