/** GET /api/w/:workspaceSlug/books/:bookId/proposals/pending-structure — the book's pending new elements and relations, a story map's ghosts and their list (`bible.view`; Phase 3.3) */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listPendingStructure } from '@/app-layer/usecases/enrichment-review';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json(await listPendingStructure(ctx, params.bookId))));
