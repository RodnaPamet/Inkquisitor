/**
 * PUT    …/books/:bookId/facts/:factId/override — the book's own answer in place of a confirmed fact it
 * inherits from an opted-in series source (Phase 4.0, D26, `bible.edit`). Body: `{ text }`. 409
 * OVERRIDE_NOT_INHERITED for any other fact. The series fact is not changed.
 * DELETE …/books/:bookId/facts/:factId/override — clear it: the inherited fact counts again.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { clearFactOverride, setFactOverride } from '@/app-layer/usecases/source-facts';

type Params = { workspaceSlug: string; bookId: string; factId: string };

export const PUT = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json(await setFactOverride(ctx, params.bookId, params.factId, await readJsonBody(req)))),
);

export const DELETE = withApiErrorHandling(requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json(await clearFactOverride(ctx, params.bookId, params.factId))));
