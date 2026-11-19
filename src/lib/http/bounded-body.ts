/**
 * A request body as bytes, read to at most `max` bytes or refused 413
 * (`PAYLOAD_TOO_LARGE`, reason `BODY_TOO_LARGE`, naming `maxBytes`) without
 * being read in full (Phase 1.1's `readJsonBody`, made shared in Phase 1.3 for
 * the bundle upload, whose body is a zip rather than JSON):
 *
 *   - a `content-length` over the cap is refused before a byte is read;
 *   - a body sent without one (chunked), or lying in it, is read as a stream
 *     that is cancelled as soon as the bytes read pass the cap.
 *
 * `req.arrayBuffer()` / `req.text()` / `req.formData()` would buffer the whole
 * body first, so one request could hold the process for as long as it took to
 * arrive. A route never calls them: it calls `readJsonBody` (JSON) or this
 * (anything else).
 */
import { DomainError } from '@/lib/errors/types';

export function bodyTooLarge(maxBytes: number): DomainError {
    return new DomainError('The request body is too large.', 'PAYLOAD_TOO_LARGE', 413, {
        reason: 'BODY_TOO_LARGE',
        maxBytes,
    });
}

/** The body's bytes, refusing (and cancelling the stream) once they pass `max`. */
export async function readBoundedBytes(req: Request, max: number): Promise<Uint8Array> {
    const declared = req.headers.get('content-length');
    if (declared !== null) {
        const n = Number(declared);
        if (Number.isFinite(n) && n > max) throw bodyTooLarge(max);
    }
    const body = req.body;
    if (!body) return new Uint8Array(0);
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
                throw bodyTooLarge(max);
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
    return bytes;
}
