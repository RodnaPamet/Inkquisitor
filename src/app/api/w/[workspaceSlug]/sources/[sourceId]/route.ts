/**
 * GET    …/sources/:sourceId — one source as it stands (Phase 4.0, `bible.view`): the pages poll it while it is read.
 * DELETE …/sources/:sourceId — remove it (`bible.edit`): its chunks, facts, vectors and opt-ins with it.
 * A source of a deleted book is a 404.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getSource, removeSource } from '@/app-layer/usecases/source-library';

type Params = { workspaceSlug: string; sourceId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json({ source: await getSource(ctx, params.sourceId) })));

export const DELETE = withApiErrorHandling(requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json(await removeSource(ctx, params.sourceId))));
