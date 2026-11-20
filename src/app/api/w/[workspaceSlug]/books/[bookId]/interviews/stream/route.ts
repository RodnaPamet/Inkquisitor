/**
 * POST /api/w/:workspaceSlug/books/:bookId/interviews/stream — start an
 * interview and generate its first round, STREAMED (Phase 2.4; `bible.edit`).
 * The body is the start route's (`InterviewStartInput`). The answer is a
 * `text/event-stream` of `InterviewStreamEvent`s (`src/lib/interview/
 * stream-events.ts`): `started` (the session's id), `planned`, `thinking`,
 * `draft`s (read-only until committed), `checking`, then `committed` with the
 * stored interview, or `refusal` with a code, and `done`. A refusal before
 * anything is written (400, 403, 503 AI_UNAVAILABLE, …) is the ordinary JSON
 * error. Closing the stream cancels the model call in flight and abandons the
 * round; the session stays resumable. Rate-limited as every mutation.
 */
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { interviewStreamResponse } from '@/lib/interview/stream-response';
import { startInterview } from '@/app-layer/usecases/interviews';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { workspaceSlug: string; bookId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => {
        const body = await readJsonBody(req);
        return interviewStreamResponse(req, (sink) => startInterview(ctx, params.bookId, body, { stream: sink, signal: sink.signal }), { workspaceId: ctx.workspaceId });
    }),
);
