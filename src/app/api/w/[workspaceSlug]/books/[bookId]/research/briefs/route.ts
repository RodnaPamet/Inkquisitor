/**
 * GET  …/books/:bookId/research/briefs — the book's research briefs, each with
 * its latest run and files (Phase 2.6, `bible.view`).
 * POST …/books/:bookId/research/briefs — write a brief (`bible.edit`). Body:
 * `{ question, purpose, scopeElementIds?, urls?, depth }` (`CreateBriefInput`).
 * 422 BRIEF_QUOTES_BIBLE when the brief repeats the book's stored text (D9).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { createResearchBrief } from '@/app-layer/usecases/research-briefs';
import { listResearchBriefs } from '@/app-layer/usecases/research-pages';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json(await listResearchBriefs(ctx, params.bookId))),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ brief: await createResearchBrief(ctx, params.bookId, await readJsonBody(req)) }, { status: 201 }),
    ),
);
