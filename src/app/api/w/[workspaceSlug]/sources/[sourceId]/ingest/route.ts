/**
 * POST …/sources/:sourceId/ingest — read the source's facts (or resume), once the author has seen the cost
 * (Phase 4.0, D23, `bible.edit`). Body: `{ confirmWorstCaseMicroUsd }`, the "at most" the page showed. 503
 * AI_UNAVAILABLE / SOURCE_FACTS_NOT_EVALUATED (D11), 409 INGEST_IN_PROGRESS, NOTHING_TO_INGEST and
 * ESTIMATE_CHANGED (with the new figures) before anything is written. 202; progress is the source's GET.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { IngestInput } from '@/app-layer/schemas/sources';
import { dispatchIngestion } from '@/app-layer/usecases/source-library';

type Params = { workspaceSlug: string; sourceId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json(await dispatchIngestion(ctx, params.sourceId, IngestInput.parse(await readJsonBody(req))), { status: 202 })),
);
