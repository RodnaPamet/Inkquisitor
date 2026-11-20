/**
 * POST …/interviews/:sessionId/rounds/stream — generate the next round,
 * STREAMED (Phase 2.4; `bible.edit`); a paused interview resumes. The events
 * are the start stream's but `started` (`src/lib/interview/stream-events.ts`);
 * the interview may instead end or pause, which `committed` says with its
 * reason. 409 ROUND_OPEN / ROUND_GENERATING and 503 AI_UNAVAILABLE are the
 * ordinary JSON errors, before anything is written. Closing the stream
 * cancels the model call in flight and abandons the round.
 */
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { interviewStreamResponse } from '@/lib/interview/stream-response';
import { nextRound } from '@/app-layer/usecases/interviews';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { workspaceSlug: string; bookId: string; sessionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        interviewStreamResponse(req, (sink) => nextRound(ctx, params.bookId, params.sessionId, { stream: sink, signal: sink.signal })),
    ),
);
