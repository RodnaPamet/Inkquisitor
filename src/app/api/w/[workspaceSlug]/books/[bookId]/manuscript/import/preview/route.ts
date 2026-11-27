/**
 * POST …/manuscript/import/preview — preview a DOCX or Markdown manuscript's split (Phase 5.1, D33, `bible.edit`). The
 * body is the file, read to at most `SOURCE_UPLOAD_MAX_BYTES` (413 past it, unread); its name in `x-source-filename`.
 * Virus-scanned and read by 4.0's reader; nothing is stored. Answers the outline, the proposed split and a token.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readBoundedBytes } from '@/lib/http/bounded-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { filenameFromHeader, SOURCE_FILENAME_HEADER } from '@/app-layer/schemas/sources';
import { previewManuscriptImport } from '@/app-layer/usecases/manuscript-import';
import { SOURCE_UPLOAD_MAX_BYTES } from '@/lib/sources/vocabulary';

type Params = { workspaceSlug: string; bookId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => {
        const bytes = await readBoundedBytes(req, SOURCE_UPLOAD_MAX_BYTES);
        return NextResponse.json({ preview: await previewManuscriptImport(ctx, params.bookId, { bytes, filename: filenameFromHeader(req.headers.get(SOURCE_FILENAME_HEADER)) }) });
    }),
);
