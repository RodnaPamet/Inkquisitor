/**
 * POST …/books/:bookId/stale-flags/:flagId/dismiss — the author says the entry still holds (Phase 4.2, D28;
 * `bible.edit`). A later change of the element it drew on raises it again. 409 FLAG_NOT_OPEN.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { dismissStaleFlag } from '@/app-layer/usecases/continuity';

type Params = { workspaceSlug: string; bookId: string; flagId: string };

export const POST = withApiErrorHandling(requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json({ flag: await dismissStaleFlag(ctx, params.bookId, params.flagId) })));
