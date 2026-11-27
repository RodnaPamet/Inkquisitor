/**
 * POST …/manuscript/chapters/:chapterId/prose-checks — re-run the chapter's prose checks (Phase 5.2, D34, `bible.edit`):
 * every scene queued, at most 200 (`{ queued, notQueued, scheduled }`).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { rerunChapterProseChecks } from '@/app-layer/usecases/prose-checks';

type Params = { workspaceSlug: string; bookId: string; chapterId: string };

export const POST = withApiErrorHandling(requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json(await rerunChapterProseChecks(ctx, params.bookId, params.chapterId))));
