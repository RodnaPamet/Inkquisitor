/**
 * POST …/books/:bookId/threads — a promise, clue or open question added by hand (Phase 4.2, D28; `bible.edit`).
 * Body: `{ kind, title, note?, state?, subjectElementId? }`. 409 THREADS_FULL; 400 STATE_NOT_ALLOWED.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { createThread } from '@/app-layer/usecases/continuity';

type Params = { workspaceSlug: string; bookId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ thread: await createThread(ctx, params.bookId, await readJsonBody(req)) }, { status: 201 })),
);
