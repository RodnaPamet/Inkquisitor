/**
 * GET …/books/:bookId/fact-proposals — the book's pending proposals to invalidate a fact (Phase 4.1, D27;
 * `bible.view`): each with both facts and where they came from. Nothing is invalidated until the author decides.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listFactProposals } from '@/app-layer/usecases/fact-proposals';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json(await listFactProposals(ctx, params.bookId))));
