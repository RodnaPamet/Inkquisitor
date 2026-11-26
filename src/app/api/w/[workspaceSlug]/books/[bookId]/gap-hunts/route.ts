/**
 * GET  …/books/:bookId/gap-hunts — the book's newest gap hunt (or the code's unranked order now), whether the model
 *      can rank it and at most for how much (Phase 4.3, D29; `bible.view`).
 * POST …/books/:bookId/gap-hunts — run one (`bible.edit`). Body: `{ confirmWorstCaseMicroUsd? }`: the ranking call's
 *      "at most" the page showed; when the model cannot rank here the code's order is stored, LABELLED UNRANKED.
 *      409 NOTHING_TO_RANK, NO_GAPS, ESTIMATE_CHANGED.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { GapHuntRunInput } from '@/app-layer/schemas/interrogation';
import { getGapHuntPage, runGapHunt } from '@/app-layer/usecases/gap-hunts';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json(await getGapHuntPage(ctx, params.bookId))));

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ hunt: await runGapHunt(ctx, params.bookId, GapHuntRunInput.parse(await readJsonBody(req))) })),
);
