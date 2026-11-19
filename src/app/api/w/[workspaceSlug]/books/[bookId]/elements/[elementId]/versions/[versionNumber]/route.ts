/** GET …/books/:bookId/elements/:elementId/versions/:versionNumber — one version with its snapshot (`bible.view`) */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getVersion } from '@/app-layer/usecases/bible-versions';

type Params = { workspaceSlug: string; bookId: string; elementId: string; versionNumber: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) =>
        NextResponse.json({ version: await getVersion(ctx, params.bookId, params.elementId, params.versionNumber) }),
    ),
);
