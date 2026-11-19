/** DELETE /api/w/:workspaceSlug/books/:bookId/relations/:relationId — remove a relation (`bible.edit`) */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { removeRelation } from '@/app-layer/usecases/bible-relations';

type Params = { workspaceSlug: string; bookId: string; relationId: string };

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json(await removeRelation(ctx, params.bookId, params.relationId))),
);
