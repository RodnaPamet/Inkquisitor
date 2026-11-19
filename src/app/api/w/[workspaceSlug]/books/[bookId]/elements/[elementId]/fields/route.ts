/**
 * PUT …/books/:bookId/elements/:elementId/fields — set a batch of field values (`bible.edit`)
 *
 *   { "fields": [{ "key": "want", "value": "…" }, { "key": "arc", "value": null }], "baseVersion": 3, "changeSummary"?: "…" }
 *
 * Each value is checked against its field's type and sanitised; `null` (or an
 * empty value) clears the field. Every refusal comes back at once (400,
 * `FIELD_VALUES_REFUSED`). A save that changes something writes one version.
 * `baseVersion` (required) is the version the edit is based on; a newer one
 * refuses the save 409 `VERSION_CONFLICT`, writing nothing.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { updateElementFields } from '@/app-layer/usecases/bible-elements';

type Params = { workspaceSlug: string; bookId: string; elementId: string };

export const PUT = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ element: await updateElementFields(ctx, params.bookId, params.elementId, await readJsonBody(req)) }),
    ),
);
