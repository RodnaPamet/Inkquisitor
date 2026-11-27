/**
 * PATCH  …/manuscript/chapters/:chapterId — rename `{ title }` (Phase 5.1, `bible.edit`).
 * DELETE …/manuscript/chapters/:chapterId?confirmScenes=N — delete it and its scenes; one holding scenes is refused
 *        409 NOT_EMPTY unless `confirmScenes` names that very count (`bible.edit`). Its scenes' histories stay with the book.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { confirmScenesParam } from '@/app-layer/schemas/manuscript';
import { deleteChapter, renameChapter } from '@/app-layer/usecases/manuscript';

type Params = { workspaceSlug: string; bookId: string; chapterId: string };

export const PATCH = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ outline: await renameChapter(ctx, params.bookId, params.chapterId, await readJsonBody(req)) })),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json(await deleteChapter(ctx, params.bookId, params.chapterId, confirmScenesParam(req.nextUrl.searchParams.get('confirmScenes')))),
    ),
);
