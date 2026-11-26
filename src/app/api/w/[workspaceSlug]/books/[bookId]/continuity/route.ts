/**
 * GET …/books/:bookId/continuity — the book's Continuity page (Phase 4.2, D28; `bible.view`): its pending
 * contradictions (both facts, both sources), the facts their entries no longer state, its promises, clues and open
 * questions and the threads proposed, its "decide later" answers, the entries that may be stale, and when the nightly
 * check last ran. A book with no live fact reads "not assessed" (rule 6).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getContinuityPage } from '@/app-layer/usecases/continuity';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json(await getContinuityPage(ctx, params.bookId))));
