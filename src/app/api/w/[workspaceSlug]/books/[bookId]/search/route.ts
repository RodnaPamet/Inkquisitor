/**
 * POST /api/w/:workspaceSlug/books/:bookId/search — word search within the book (`bible.view`; Phase 3.4).
 *      Body `{ "q": "…" }`: unquoted words match by stem, a "quoted phrase" by its words in sequence.
 *      200 with the ranked elements, each with plain-text snippets and highlight ranges; 400 with
 *      `details.reason` QUERY_TOO_LONG / QUERY_TOO_MANY_TERMS / QUERY_TOO_MANY_PHRASES.
 *
 * A POST, not a GET with `?q=`: the query is author text, and a URL is not private — Next's own
 * request span records `http.target` with its query string, and a reverse proxy's access log
 * records the URI — while no layer logs a request body (the 3.4 note). It reads and changes
 * nothing, so it is charged to the READ budget (`API_READ_LIMIT`), not the mutation tier.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';
import { searchBook } from '@/app-layer/usecases/book-search';

type Params = { workspaceSlug: string; bookId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (req, { params }, ctx) => NextResponse.json(await searchBook(ctx, params.bookId, await readJsonBody(req)))),
    { rateLimit: { config: API_READ_LIMIT, scope: 'book-search' } },
);
