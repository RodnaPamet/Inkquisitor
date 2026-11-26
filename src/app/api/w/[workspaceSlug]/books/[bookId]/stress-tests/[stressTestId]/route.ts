/**
 * GET …/books/:bookId/stress-tests/:stressTestId — one stress test as it stands (Phase 4.3, D29; `bible.view`): its
 * state, what it read and left out, and its weak points with their questions and citations. The page polls it while
 * it runs.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { IdParam } from '@/app-layer/schemas/interrogation';
import { getStressTest } from '@/app-layer/usecases/stress-tests';

type Params = { workspaceSlug: string; bookId: string; stressTestId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json({ stressTest: await getStressTest(ctx, params.bookId, IdParam.parse(params.stressTestId)) })),
);
