/**
 * /api/w/:workspaceSlug/books/:bookId/interviews (Phase 2.2)
 *
 *   GET   the book's interviews, newest first (`bible.view`)
 *   POST  start one (`bible.edit`) and generate its first round:
 *         { "scope": "ELEMENT" | "KIND" | "BOOK", "elementId"?, "kind"?, "depth"?: 1..5,
 *           "detail"?: 1..5, "persona"?: "socratic" | …, "offerRecommended"?, "preferChoice"? }
 *         503 MODEL_NOT_WIRED until the model layer is wired (nothing is written).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listInterviews, startInterview } from '@/app-layer/usecases/interviews';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json(await listInterviews(ctx, params.bookId))),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ interview: await startInterview(ctx, params.bookId, await readJsonBody(req)) }, { status: 201 }),
    ),
);
