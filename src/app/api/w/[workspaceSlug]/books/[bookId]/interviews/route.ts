/**
 * /api/w/:workspaceSlug/books/:bookId/interviews (Phase 2.2; dials and packs 2.3)
 *
 *   GET   the book's interviews, newest first (`bible.view`)
 *   POST  start one (`bible.edit`) and generate its first round:
 *         { "scope": "ELEMENT" | "KIND" | "BOOK", "elementId"?, "kind"?, "depth"?: 1..5,
 *           "detail"?: 1..5, "personaKeys"?: ["socratic", …] (at most 3; Phase 2.3),
 *           "offerRecommended"?, "preferChoice"? } — a dial left out comes from the
 *         book's defaults, then the workspace's, then the code default.
 *         503 AI_UNAVAILABLE when no model call can be made, 503 PACKS_NOT_MOUNTABLE
 *         when a pack the session would mount does not (nothing is written either way).
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
