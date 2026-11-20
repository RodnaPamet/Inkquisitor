/**
 * /api/w/:workspaceSlug/books/:bookId/interview-defaults (Phase 2.3) — the
 * book's interview dial defaults, which take precedence over the workspace's.
 *
 *   GET  the stored layer, what a session started with no dials of its own
 *        would run with (`effective`: book, then workspace, then code default),
 *        where each dial comes from (`sources`) and what they do (`effects`)
 *        (`bible.view`)
 *   PUT  replace the layer (`bible.edit`), the same body as the workspace's:
 *        a key left out or null passes the dial on to the workspace's default
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getBookInterviewDefaults, setBookInterviewDefaults } from '@/app-layer/usecases/interview-defaults';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json({ defaults: await getBookInterviewDefaults(ctx, params.bookId) })),
);

export const PUT = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ defaults: await setBookInterviewDefaults(ctx, params.bookId, await readJsonBody(req)) }),
    ),
);
