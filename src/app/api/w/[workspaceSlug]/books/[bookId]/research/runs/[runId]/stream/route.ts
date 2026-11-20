/**
 * GET …/research/runs/:runId/stream — a run's progress, STREAMED (Phase 2.6,
 * `bible.view`; `src/lib/research/stream-events.ts`): `progress` as the stored
 * phase and counts change, `finished` with the ended run, then `done`. Closing
 * the stream stops the reading, never the run.
 */
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { researchStreamResponse } from '@/lib/research/stream-response';
import { getResearchRun } from '@/app-layer/usecases/research-pages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { workspaceSlug: string; bookId: string; runId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (req, { params }, ctx) => researchStreamResponse(req, () => getResearchRun(ctx, params.bookId, params.runId))),
);
