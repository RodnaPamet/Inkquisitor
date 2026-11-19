/**
 * POST …/books/:bookId/elements/:elementId/versions/:versionNumber/restore — apply that version's
 * snapshot as a NEW version (`bible.edit`). Body optional: `{ "changeSummary"?: "…" }`.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { restoreVersion } from '@/app-layer/usecases/bible-versions';

type Params = { workspaceSlug: string; bookId: string; elementId: string; versionNumber: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json(
            { restore: await restoreVersion(ctx, params.bookId, params.elementId, params.versionNumber, await readJsonBody(req, { optional: true })) },
            { status: 201 },
        ),
    ),
);
