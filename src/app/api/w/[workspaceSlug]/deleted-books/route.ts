/**
 * GET /api/w/:workspaceSlug/deleted-books — the workspace's books deleted in the
 * last 30 days, still restorable, newest deletion first (`books.delete`, OWNER).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listDeletedBooks } from '@/app-layer/usecases/books';

export const GET = withApiErrorHandling(requirePermission('books.delete', async (_req, _args, ctx) => NextResponse.json(await listDeletedBooks(ctx))));
