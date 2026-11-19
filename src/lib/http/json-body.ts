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
 * `optional`: an empty body reads as `{}` (an action whose every input is optional).
 */
import type { NextRequest } from 'next/server';
import { DomainError, ValidationError } from '@/lib/errors/types';

/**
 * The largest JSON body a route reads: 2 MiB. The largest legitimate request
 * is one field save, whose raw values the request schemas bound
 * (`src/app-layer/schemas/bible.ts`); a body past this is refused before
 * parsing, whatever it holds.
 */
export const JSON_BODY_MAX_BYTES = 2 * 1024 * 1024;

function tooLarge(): DomainError {
    return new DomainError('The request body is too large.', 'PAYLOAD_TOO_LARGE', 413, {
        reason: 'BODY_TOO_LARGE',
        maxBytes: JSON_BODY_MAX_BYTES,
    });
}

/** The body as text, refusing (and cancelling the stream) once it passes `max` bytes. */
async function readBoundedText(req: NextRequest, max: number): Promise<string> {
    const declared = req.headers.get('content-length');
    if (declared !== null) {
        const n = Number(declared);
        if (Number.isFinite(n) && n > max) throw tooLarge();
    }
    const body = req.body;
    if (!body) return '';
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > max) {
                await reader.cancel().catch(() => undefined);
                throw tooLarge();
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
    }
    return new TextDecoder().decode(bytes);
}

export async function readJsonBody(req: NextRequest, options: { optional?: boolean } = {}): Promise<unknown> {
    const text = await readBoundedText(req, JSON_BODY_MAX_BYTES);
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
