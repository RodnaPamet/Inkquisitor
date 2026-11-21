/**
 * GET  …/series/sources — the workspace's series library (Phase 4.0, D26, `bible.view`).
 * POST …/series/sources — upload a source into it (`bible.edit`), as a book's upload: the body is the file,
 * bounded (413), its name in the `x-source-filename` header. 201 with the source and its cost estimate.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readBoundedBytes } from '@/lib/http/bounded-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { filenameFromHeader, SOURCE_FILENAME_HEADER } from '@/app-layer/schemas/sources';
import { listSeriesSources, uploadSource } from '@/app-layer/usecases/source-library';
import { SOURCE_UPLOAD_MAX_BYTES } from '@/lib/sources/vocabulary';

type Params = { workspaceSlug: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, _route, ctx) => NextResponse.json(await listSeriesSources(ctx))));

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, _route, ctx) => {
        const bytes = await readBoundedBytes(req, SOURCE_UPLOAD_MAX_BYTES);
        const source = await uploadSource(ctx, { kind: 'series' }, { bytes, filename: filenameFromHeader(req.headers.get(SOURCE_FILENAME_HEADER)) });
        return NextResponse.json({ source }, { status: 201 });
    }),
);
