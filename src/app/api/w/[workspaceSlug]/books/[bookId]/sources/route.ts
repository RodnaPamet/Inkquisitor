/**
 * GET  …/books/:bookId/sources — the book's sources and the series sources it may draw on (Phase 4.0, `bible.view`).
 * POST …/books/:bookId/sources — upload a source into the book's library (`bible.edit`). The body is the
 * file itself, read to at most `SOURCE_UPLOAD_MAX_BYTES` (413 past it, unread); its name travels in the
 * `x-source-filename` header, percent-encoded. Virus-scanned, sniffed, parsed and chunked; only the
 * encrypted chunks are kept. 201 with the source and its cost estimate; nothing is sent to a model.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readBoundedBytes } from '@/lib/http/bounded-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { filenameFromHeader, SOURCE_FILENAME_HEADER } from '@/app-layer/schemas/sources';
import { listBookSources, uploadSource } from '@/app-layer/usecases/source-library';
import { SOURCE_UPLOAD_MAX_BYTES } from '@/lib/sources/vocabulary';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json(await listBookSources(ctx, params.bookId))));

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => {
        const bytes = await readBoundedBytes(req, SOURCE_UPLOAD_MAX_BYTES);
        const source = await uploadSource(ctx, { kind: 'book', bookId: params.bookId }, { bytes, filename: filenameFromHeader(req.headers.get(SOURCE_FILENAME_HEADER)) });
        return NextResponse.json({ source }, { status: 201 });
    }),
);
