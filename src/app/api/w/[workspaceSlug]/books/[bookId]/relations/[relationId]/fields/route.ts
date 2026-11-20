/** PUT /api/w/:workspaceSlug/books/:bookId/relations/:relationId/fields — save a relation's fields, a versioned save (`bible.edit`; Phase 3.3, D24) */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { saveRelationFields } from '@/app-layer/usecases/bible-relations';

type Params = { workspaceSlug: string; bookId: string; relationId: string };

export const PUT = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ relation: await saveRelationFields(ctx, params.bookId, params.relationId, await readJsonBody(req)) }),
    ),
);
