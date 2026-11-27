/** POST …/manuscript/chapters/:chapterId/move — `{ partId, after?, before? }` (Phase 5.1, `bible.edit`; 409 ORDER_STALE). */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { moveChapter } from '@/app-layer/usecases/manuscript';

type Params = { workspaceSlug: string; bookId: string; chapterId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ outline: await moveChapter(ctx, params.bookId, params.chapterId, await readJsonBody(req)) })),
);
