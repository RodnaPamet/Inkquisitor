/**
 * POST …/research/briefs/:briefId/sources?filename=notes.md — attach a text file
 * to a brief (Phase 2.6, `bible.edit`), through the 1.3 import path. The body is
 * the file itself (`text/plain` or `text/markdown`), read to at most
 * `SOURCE_UPLOAD_MAX_BYTES` (413 past it, unread), virus-scanned, decoded as
 * UTF-8 and stored as encrypted text, never as a file.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readBoundedBytes } from '@/lib/http/bounded-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { SOURCE_UPLOAD_MAX_BYTES } from '@/app-layer/schemas/research';
import { attachResearchSource } from '@/app-layer/usecases/research-briefs';

type Params = { workspaceSlug: string; bookId: string; briefId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => {
        const mediaType = req.headers.get('content-type') ?? '';
        const bytes = await readBoundedBytes(req, SOURCE_UPLOAD_MAX_BYTES);
        const filename = (req.nextUrl.searchParams.get('filename') ?? '').slice(0, 800);
        const source = await attachResearchSource(ctx, params.bookId, params.briefId, { bytes, mediaType, filename });
        return NextResponse.json({ source }, { status: 201 });
    }),
);
