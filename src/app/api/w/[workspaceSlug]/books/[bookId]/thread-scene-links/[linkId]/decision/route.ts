/**
 * POST …/books/:bookId/thread-scene-links/:linkId/decision — confirm or reject a proposed link between a thread and the
 * scene that plants or pays it off (Phase 5.3, D35 item 4; `bible.edit`). Body: `{ decision: 'CONFIRM' | 'REJECT' }`.
 * 409 LINK_DECIDED.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { decideThreadSceneLink } from '@/app-layer/usecases/thread-scene-links';

type Params = { workspaceSlug: string; bookId: string; linkId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ link: await decideThreadSceneLink(ctx, params.bookId, params.linkId, await readJsonBody(req)) })),
);
