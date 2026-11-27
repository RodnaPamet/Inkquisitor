/**
 * POST   …/manuscript/prose-checks/dismissals — dismiss one note `{ findingId }` (Phase 5.2, D34, `bible.edit`): it stays
 *        dismissed while its sentence is unchanged (404 FINDING_GONE when the note was replaced by a newer check).
 * DELETE …/manuscript/prose-checks/dismissals — bring every dismissed note of the book back (`bible.edit`).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { clearProseDismissals, dismissProseFinding } from '@/app-layer/usecases/prose-checks';

type Params = { workspaceSlug: string; bookId: string };

export const POST = withApiErrorHandling(requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json(await dismissProseFinding(ctx, params.bookId, await readJsonBody(req)))));

export const DELETE = withApiErrorHandling(requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json(await clearProseDismissals(ctx, params.bookId))));
