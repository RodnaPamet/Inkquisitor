/**
 * GET    …/books/:bookId/elements/:elementId — the element, every template field, its relations from both ends (`bible.view`)
 * PATCH  …/books/:bookId/elements/:elementId — change name, slug, status, summary or custom label; writes a version (`bible.edit`)
 * DELETE …/books/:bookId/elements/:elementId — delete it and its relations; its version history stays with the book (`bible.edit`)
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { deleteElement, getElement, updateElement } from '@/app-layer/usecases/bible-elements';

type Params = { workspaceSlug: string; bookId: string; elementId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) =>
        NextResponse.json({ element: await getElement(ctx, params.bookId, params.elementId) }),
    ),
);

export const PATCH = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ element: await updateElement(ctx, params.bookId, params.elementId, await readJsonBody(req)) }),
    ),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json(await deleteElement(ctx, params.bookId, params.elementId))),
);
