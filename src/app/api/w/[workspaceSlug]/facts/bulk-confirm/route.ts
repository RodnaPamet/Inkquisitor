/**
 * POST …/facts/bulk-confirm — confirm facts a Facts page showed (Phase 4.0, D26, `bible.edit`). Body:
 * `{ view, offeredIds, issuedAt, token, factIds }` as the page read them. 409 VIEW_EXPIRED for a bad or old
 * token, 409 FACTS_NOT_OFFERED for an id the view did not offer; each named fact is confirmed only while
 * still pending, unflagged and in the view.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { BulkConfirmInput } from '@/app-layer/schemas/sources';
import { bulkConfirmFacts } from '@/app-layer/usecases/source-facts';

type Params = { workspaceSlug: string };

export const POST = withApiErrorHandling(requirePermission<Params>('bible.edit', async (req, _route, ctx) => NextResponse.json(await bulkConfirmFacts(ctx, BulkConfirmInput.parse(await readJsonBody(req))))));
