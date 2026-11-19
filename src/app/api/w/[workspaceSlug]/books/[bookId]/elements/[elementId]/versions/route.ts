/**
 * GET …/books/:bookId/elements/:elementId/versions[?take=50&before=12] — the element's versions,
 * newest first, without their snapshots (`bible.view`)
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listVersions } from '@/app-layer/usecases/bible-versions';

type Params = { workspaceSlug: string; bookId: string; elementId: string };

const Query = z
    .object({
        take: z.coerce.number().int().min(1).max(100).optional(),
        before: z.coerce.number().int().min(1).optional(),
    })
    .strict();

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (req, { params }, ctx) => {
        const query = Query.parse(Object.fromEntries(req.nextUrl.searchParams));
        return NextResponse.json({ versions: await listVersions(ctx, params.bookId, params.elementId, query) });
    }),
);
