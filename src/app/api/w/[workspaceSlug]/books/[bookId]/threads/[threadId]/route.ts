/**
 * PATCH  …/books/:bookId/threads/:threadId — edit a thread by hand (Phase 4.2, D28; `bible.edit`). Body:
 * `{ baseVersion, title?, note?, state?, subjectElementId? }`; 409 VERSION_CONFLICT when it moved.
 * DELETE …/books/:bookId/threads/:threadId?baseVersion=N — remove it, against the version the author saw (a number, never text).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { deleteThread, updateThread } from '@/app-layer/usecases/continuity';

type Params = { workspaceSlug: string; bookId: string; threadId: string };

export const PATCH = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ thread: await updateThread(ctx, params.bookId, params.threadId, await readJsonBody(req)) })),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json(await deleteThread(ctx, params.bookId, params.threadId, new URL(req.url).searchParams.get('baseVersion')))),
);
