/**
 * GET /api/w/:workspaceSlug/interview-packs (Phase 2.3) — the interview packs
 * a session may mount: the six personas (the manner dial) and the craft pack
 * of each element kind, each with its mount status (`mountable`, or the named
 * `refusal`), and which evaluation records mount a pack here (`recordMode`).
 * `bible.view`. No pack text is returned.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listInterviewPacks } from '@/app-layer/usecases/interview-packs';

export const GET = withApiErrorHandling(
    requirePermission('bible.view', async (_req, _args, ctx) => NextResponse.json(await listInterviewPacks(ctx))),
);
