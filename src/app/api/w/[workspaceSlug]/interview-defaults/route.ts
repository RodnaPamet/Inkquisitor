/**
 * /api/w/:workspaceSlug/interview-defaults (Phase 2.3) — the workspace's
 * interview dial defaults.
 *
 *   GET  the stored layer, what it resolves to with the code defaults beneath
 *        it (`effective`, `sources`) and what those dials do (`effects`)
 *        (`bible.view`)
 *   PUT  replace the layer (`bible.edit`):
 *        { "depth"?: 1..5, "detail"?: 1..5, "personaKeys"?: ["socratic", …] (at most 3),
 *          "offerRecommended"?: bool, "preferChoice"?: bool } — a key left out or null
 *        passes the dial on to the code default
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getWorkspaceInterviewDefaults, setWorkspaceInterviewDefaults } from '@/app-layer/usecases/interview-defaults';

export const GET = withApiErrorHandling(
    requirePermission('bible.view', async (_req, _args, ctx) => NextResponse.json({ defaults: await getWorkspaceInterviewDefaults(ctx) })),
);

export const PUT = withApiErrorHandling(
    requirePermission('bible.edit', async (req, _args, ctx) => NextResponse.json({ defaults: await setWorkspaceInterviewDefaults(ctx, await readJsonBody(req)) })),
);
