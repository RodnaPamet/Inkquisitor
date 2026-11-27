/**
 * POST …/manuscript/import — write the confirmed split (Phase 5.1, D33, `bible.edit`): the same file again as the body
 * (bounded as the preview's), the plan the author chose in `x-import-plan` (base64url JSON, with the preview's token).
 * ONE transaction; 201 with the counts. The file is not stored and is not added to the source library.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readBoundedBytes } from '@/lib/http/bounded-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { filenameFromHeader, SOURCE_FILENAME_HEADER } from '@/app-layer/schemas/sources';
import { confirmManuscriptImport } from '@/app-layer/usecases/manuscript-import';
import { IMPORT_PLAN_HEADER } from '@/lib/manuscript/vocabulary';
import { SOURCE_UPLOAD_MAX_BYTES } from '@/lib/sources/vocabulary';

type Params = { workspaceSlug: string; bookId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => {
        const bytes = await readBoundedBytes(req, SOURCE_UPLOAD_MAX_BYTES);
        const result = await confirmManuscriptImport(ctx, params.bookId, { bytes, filename: filenameFromHeader(req.headers.get(SOURCE_FILENAME_HEADER)) }, req.headers.get(IMPORT_PLAN_HEADER));
        return NextResponse.json({ imported: result }, { status: 201 });
    }),
);
