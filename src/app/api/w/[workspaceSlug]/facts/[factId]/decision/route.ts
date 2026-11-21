/**
 * POST …/facts/:factId/decision — confirm or reject one source fact (Phase 4.0, D23, `bible.edit`). Body:
 * `{ decision: 'CONFIRM' | 'REJECT' }`. Only a confirmed fact counts as answered.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { DecisionInput } from '@/app-layer/schemas/sources';
import { decideFact } from '@/app-layer/usecases/source-facts';

type Params = { workspaceSlug: string; factId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ fact: await decideFact(ctx, params.factId, DecisionInput.parse(await readJsonBody(req)).decision) })),
);
