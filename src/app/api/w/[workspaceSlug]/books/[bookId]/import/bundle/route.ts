/**
 * POST /api/w/:workspaceSlug/books/:bookId/import/bundle[?bookDetails=apply] — import a
 * Markdown bundle into the book (`bible.edit`, Phase 1.3)
 *
 * The body is the zip itself (`application/zip`, or `application/octet-stream`
 * as a browser may label a file), read to at most `BUNDLE_UPLOAD_MAX_BYTES`
 * (413 past it, unread). The answer is the import report; a refused bundle is
 * a 400 `BUNDLE_REFUSED` listing every problem, with nothing written.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { ValidationError } from '@/lib/errors/types';
import { readBoundedBytes } from '@/lib/http/bounded-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { BUNDLE_UPLOAD_MAX_BYTES } from '@/app-layer/schemas/bible-transfer';
import { importBibleBundle } from '@/app-layer/usecases/bible-import';

type Params = { workspaceSlug: string; bookId: string };

const ZIP_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => {
        const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (!ZIP_TYPES.includes(type)) throw new ValidationError('Send the bundle as application/zip.', { reason: 'NOT_A_ZIP_UPLOAD' });
        const bytes = await readBoundedBytes(req, BUNDLE_UPLOAD_MAX_BYTES);
        const bookDetails = req.nextUrl.searchParams.get('bookDetails');
        const report = await importBibleBundle(ctx, params.bookId, bytes, bookDetails ? { bookDetails } : {});
        return NextResponse.json({ report });
    }),
);
