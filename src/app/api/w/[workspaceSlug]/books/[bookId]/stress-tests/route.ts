/**
 * GET  …/books/:bookId/stress-tests — the book's stress tests and the next one's estimate (Phase 4.3, D29;
 *      `bible.view`): what it would read and leave out, its "at most", and why one cannot start here, if so. A book
 *      with nothing in it reads "not assessed" (rule 6).
 * POST …/books/:bookId/stress-tests — start one (`bible.edit`). Body: `{ confirmWorstCaseMicroUsd }`, the "at most"
 *      the page showed. 503 AI_UNAVAILABLE / STRESS_TEST_NOT_EVALUATED (D11), 409 STRESS_TEST_IN_PROGRESS,
 *      NOTHING_TO_TEST, CALL_OVER_BUDGET and ESTIMATE_CHANGED before anything is written. 202; the test runs as a job.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { StressTestStartInput } from '@/app-layer/schemas/interrogation';
import { getStressTestPage, startStressTest } from '@/app-layer/usecases/stress-tests';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json(await getStressTestPage(ctx, params.bookId))));

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ stressTest: await startStressTest(ctx, params.bookId, StressTestStartInput.parse(await readJsonBody(req))) }, { status: 202 }),
    ),
);
