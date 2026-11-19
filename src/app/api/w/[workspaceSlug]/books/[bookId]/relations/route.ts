/**
 * POST /api/w/:workspaceSlug/books/:bookId/relations — relate two elements of the book (`bible.edit`)
 *
 *   { "fromElementId": "…", "toElementId": "…", "type": "member_of", "note"?: "…" }
 *
 * The type must be declared by the `from` element's kind for the `to`
 * element's kind, or the built-in `related_to`.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { addRelation } from '@/app-layer/usecases/bible-relations';

type Params = { workspaceSlug: string; bookId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ relation: await addRelation(ctx, params.bookId, await readJsonBody(req)) }, { status: 201 }),
    ),
);
