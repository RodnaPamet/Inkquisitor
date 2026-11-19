/**
 * `readJsonBody` (src/lib/http/json-body.ts): a malformed body is a 400, and a
 * body past JSON_BODY_MAX_BYTES is a 413 WITHOUT being read in full — refused
 * on its declared length before a byte is read, and cut off once a streamed
 * body passes the cap.
 */
import { NextRequest } from 'next/server';
import { JSON_BODY_MAX_BYTES, readJsonBody } from '@/lib/http/json-body';

const CHUNK = 64 * 1024;

/** A body of `chunks` 64 KiB chunks, counting how many were pulled. */
function countingBody(chunks: number) {
    const state = { pulled: 0 };
    const stream = new ReadableStream<Uint8Array>(
        {
            pull(controller) {
                if (state.pulled >= chunks) {
                    controller.close();
                    return;
                }
                state.pulled++;
                controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
            },
        },
        { highWaterMark: 0 },
    );
    return { stream, state };
}

function request(body: ReadableStream<Uint8Array> | string, headers: Record<string, string> = {}) {
    const init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> & { duplex: 'half' } = {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
        duplex: 'half', // a stream body needs it
    };
    return new NextRequest('http://localhost/api/w/x/books', init);
}

async function statusOf(p: Promise<unknown>): Promise<{ status?: number; details?: unknown }> {
    try {
        await p;
        return {};
    } catch (err) {
        return err as { status?: number; details?: unknown };
    }
}

it('parses a body within the cap, and answers a malformed one 400', async () => {
    await expect(readJsonBody(request('{"title":"x"}'))).resolves.toEqual({ title: 'x' });
    expect((await statusOf(readJsonBody(request('{nope')))).status).toBe(400);
    await expect(readJsonBody(request(''), { optional: true })).resolves.toEqual({});
});

it('refuses a declared length over the cap before reading a byte', async () => {
    const { stream, state } = countingBody(100);
    const refused = await statusOf(readJsonBody(request(stream, { 'content-length': String(JSON_BODY_MAX_BYTES + 1) })));
    expect(refused.status).toBe(413);
    expect(refused.details).toMatchObject({ reason: 'BODY_TOO_LARGE' });
    expect(state.pulled).toBe(0);
});

it('stops reading a streamed body once it passes the cap', async () => {
    const chunks = 160; // 10 MiB on offer
    const { stream, state } = countingBody(chunks);
    const refused = await statusOf(readJsonBody(request(stream)));
    expect(refused.status).toBe(413);
    expect(state.pulled).toBeLessThanOrEqual(JSON_BODY_MAX_BYTES / CHUNK + 2);
    expect(state.pulled).toBeLessThan(chunks);
});
