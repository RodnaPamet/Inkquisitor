/**
 * POST …/books/:bookId/elements/:elementId/order — move a plot beat or a
 * timeline event in its story order (`bible.edit`; Phase 3.2, decision D22)
 *
 *   { "baseVersion": 4, "after": "<element id>" | null, "before": "<element id>" | null, "act"?: "crisis" }
 *
 * `after` and `before` are the placed elements of the same kind either side of
 * the drop (null for an open end); `act` moves a beat into another act. A move
 * is a save of the element: it writes one version (`movedInOrder`), or nothing
 * when the element already stood there. Refusals: 400 `ORDER_NOT_ALLOWED`,
 * `ORDER_ACT_NOT_ALLOWED`, `ORDER_SELF`, `FIELD_VALUES_REFUSED`; 409
 * `VERSION_CONFLICT`, `ORDER_STALE`, `ORDER_RANK_EXHAUSTED`
 * (`src/app-layer/usecases/bible-order.ts`).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { moveElementInOrder } from '@/app-layer/usecases/bible-order';

type Params = { workspaceSlug: string; bookId: string; elementId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ move: await moveElementInOrder(ctx, params.bookId, params.elementId, await readJsonBody(req)) }),
    ),
);
