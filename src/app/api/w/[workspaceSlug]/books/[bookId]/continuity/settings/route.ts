/**
 * GET …/continuity/settings — the book's continuity settings: whether the nightly deep check also reads the book's
 *     draft facts (D35 addendum A, off by default; `bible.view`).
 * PUT …/continuity/settings — replace them `{ deepReadsDraft }` (`bible.edit`; audited with ids and codes only).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getContinuitySettings, saveContinuitySettings } from '@/app-layer/usecases/continuity';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json(await getContinuitySettings(ctx, params.bookId))));

export const PUT = withApiErrorHandling(requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json(await saveContinuitySettings(ctx, params.bookId, await readJsonBody(req)))));
