/** POST …/manuscript/parts/:partId/move — `{ after?, before? }` among the parts (Phase 5.1, `bible.edit`; 409 ORDER_STALE). */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { movePart } from '@/app-layer/usecases/manuscript';

type Params = { workspaceSlug: string; bookId: string; partId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ outline: await movePart(ctx, params.bookId, params.partId, await readJsonBody(req)) })),
);
