/**
 * The JSON body of a request, or a 400 (or a 413). `req.json()` throws a bare
 * SyntaxError on a malformed body, which the error handler cannot tell from
 * a server fault (500); this answers it as the caller's mistake instead. The
 * parser's message (which can quote the body) is not passed on.
 *
 * BOUNDED. A body longer than `JSON_BODY_MAX_BYTES` is refused 413
 * (`PAYLOAD_TOO_LARGE`, reason `BODY_TOO_LARGE`) without being read in full:
 * a `content-length` over the cap is refused before a byte is read, and a
 * body sent without one (chunked) or lying in it is read as a stream that is
 * cancelled as soon as the bytes read pass the cap. `req.text()` /
 * `req.json()` would buffer the whole body first, so one request could hold
 * the event loop for as long as it took to arrive and parse.
 *
 * The bounded read is `readBoundedBytes` (`./bounded-body.ts`), shared with
 * the routes whose body is not JSON (Phase 1.3's bundle upload).
 *
 * `optional`: an empty body reads as `{}` (an action whose every input is optional).
 */
import type { NextRequest } from 'next/server';
import { ValidationError } from '@/lib/errors/types';
import { readBoundedBytes } from './bounded-body';

/**
 * The largest JSON body a route reads: 2 MiB. The largest legitimate request
 * is one field save, whose raw values the request schemas bound
 * (`src/app-layer/schemas/bible.ts`); a body past this is refused before
 * parsing, whatever it holds.
 */
export const JSON_BODY_MAX_BYTES = 2 * 1024 * 1024;

export async function readJsonBody(req: NextRequest, options: { optional?: boolean } = {}): Promise<unknown> {
    const text = new TextDecoder().decode(await readBoundedBytes(req, JSON_BODY_MAX_BYTES));
    if (text.trim() === '') {
        if (options.optional) return {};
        throw new ValidationError('A JSON body is required.', { reason: 'BODY_REQUIRED' });
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new ValidationError('The body is not valid JSON.', { reason: 'BODY_NOT_JSON' });
    }
}
