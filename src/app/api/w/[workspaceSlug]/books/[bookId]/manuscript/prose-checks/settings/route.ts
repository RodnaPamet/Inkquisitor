/**
 * GET …/manuscript/prose-checks/settings — the book's prose-check settings: rules off, the inclusive-language switch,
 *     the style sheet in use, the dismissals' count, character names that look alike (Phase 5.2, D34, `bible.view`).
 * PUT …/manuscript/prose-checks/settings — replace them `{ alexEnabled, rulesOff }` (`bible.edit`; 400 UNKNOWN_RULE).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getProseCheckSettings, saveProseCheckSettings } from '@/app-layer/usecases/prose-checks';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json(await getProseCheckSettings(ctx, params.bookId))));

export const PUT = withApiErrorHandling(requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json(await saveProseCheckSettings(ctx, params.bookId, await readJsonBody(req)))));
