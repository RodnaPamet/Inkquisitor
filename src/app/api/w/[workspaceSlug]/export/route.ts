/**
 * POST /api/w/:workspaceSlug/export — everything the workspace holds, as ONE AES-256 encrypted zip
 * (`workspace.export`, OWNER; Phase 5.H-a, D36). Body: `{ passphrase }` — in the body only, never a URL; never
 * stored, logged or audited. The archive is streamed as it is written (`usecases/workspace-export.ts`).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { contentDispositionHeader } from '@/lib/http/content-disposition';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { startWorkspaceExport } from '@/app-layer/usecases/workspace-export';

export const POST = withApiErrorHandling(
    requirePermission('workspace.export', async (req, _args, ctx) => {
        const { fileName, stream } = await startWorkspaceExport(ctx, await readJsonBody(req));
        return new NextResponse(stream, {
            status: 200,
            headers: { 'content-type': 'application/zip', 'content-disposition': contentDispositionHeader(fileName), 'cache-control': 'no-store' },
        });
    }),
);
