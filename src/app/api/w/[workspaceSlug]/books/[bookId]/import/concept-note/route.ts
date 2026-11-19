/**
 * POST /api/w/:workspaceSlug/books/:bookId/import/concept-note — store a pasted or
 * uploaded free-text concept note as a RESEARCH element (`bible.edit`, Phase 1.3)
 *
 * Body: `{ text, name?, slug? }` (an uploaded .txt or .md is read as text by
 * the browser and sent the same way). 201 when the note made a new element,
 * 200 when it updated or left the one its slug names.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { importConceptNote } from '@/app-layer/usecases/bible-import';

type Params = { workspaceSlug: string; bookId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => {
        const report = await importConceptNote(ctx, params.bookId, await readJsonBody(req));
        return NextResponse.json({ report }, { status: report.outcome === 'created' ? 201 : 200 });
    }),
);
