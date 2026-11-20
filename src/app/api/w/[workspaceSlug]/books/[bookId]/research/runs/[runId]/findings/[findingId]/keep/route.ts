/**
 * POST …/research/runs/:runId/findings/:findingId/keep — keep a finding as a new
 * research note, its claim, summary and citations (Phase 2.6, `bible.edit`).
 * Body: `{ name? }`. One version with source RESEARCH naming the finding; 409
 * FINDING_KEPT, ELEMENT_EXISTS.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { keepFindingAsNote } from '@/app-layer/usecases/research-review';

type Params = { workspaceSlug: string; bookId: string; runId: string; findingId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ kept: await keepFindingAsNote(ctx, params.bookId, params.runId, params.findingId, await readJsonBody(req, { optional: true })) }, { status: 201 }),
    ),
);
