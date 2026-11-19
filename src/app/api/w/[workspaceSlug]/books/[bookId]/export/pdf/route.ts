/**
 * GET /api/w/:workspaceSlug/books/:bookId/export/pdf — the book's bible as one PDF,
 * downloaded as `<book>-bible.pdf` (`bible.view`, Phase 1.3)
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { contentDispositionHeader } from '@/lib/http/content-disposition';
import { requirePermission } from '@/lib/security/permission-middleware';
import { exportBiblePdf } from '@/app-layer/usecases/bible-export';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) => {
        const file = await exportBiblePdf(ctx, params.bookId);
        return new NextResponse(Buffer.from(file.bytes), {
            status: 200,
            headers: {
                'content-type': file.contentType,
                'content-disposition': contentDispositionHeader(file.fileName),
                'cache-control': 'no-store',
            },
        });
    }),
);
