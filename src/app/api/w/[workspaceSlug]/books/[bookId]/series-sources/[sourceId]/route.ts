/**
 * PUT    …/books/:bookId/series-sources/:sourceId — the book draws on this series source (Phase 4.0, D26, `bible.edit`).
 * DELETE …/books/:bookId/series-sources/:sourceId — it stops. Its facts then no longer count for the book.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { setSeriesOptIn } from '@/app-layer/usecases/source-library';

type Params = { workspaceSlug: string; bookId: string; sourceId: string };

export const PUT = withApiErrorHandling(requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json(await setSeriesOptIn(ctx, params.bookId, params.sourceId, true))));

export const DELETE = withApiErrorHandling(requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json(await setSeriesOptIn(ctx, params.bookId, params.sourceId, false))));
