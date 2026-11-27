/** POST …/manuscript/scenes — a new, empty scene `{ chapterId, title?, after?, before? }` (Phase 5.1, `bible.edit`). 201 with its id and the outline. */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { createScene } from '@/app-layer/usecases/manuscript';

type Params = { workspaceSlug: string; bookId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json(await createScene(ctx, params.bookId, await readJsonBody(req)), { status: 201 })),
);
