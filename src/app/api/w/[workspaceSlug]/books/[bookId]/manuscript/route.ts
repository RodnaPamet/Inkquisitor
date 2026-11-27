/**
 * GET …/books/:bookId/manuscript — the manuscript's outline: parts → chapters → scenes, titles and word counts,
 * no text (Phase 5.1, `bible.view`). A book nobody has written in reads as an empty manuscript.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getManuscriptOutline } from '@/app-layer/usecases/manuscript';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json({ outline: await getManuscriptOutline(ctx, params.bookId) })));
