/**
 * A fake Anthropic Messages API for tests: a `fetch` the SDK is handed through
 * `clientForRun`'s test seam (`ClientOptions.fetch`), so a test drives the
 * real SDK, the real messages-only middleware and the real stream parser, and
 * nothing reaches a network.
 *
 * Each request is answered by the next scripted turn, in order. A turn is a
 * streamed (SSE) message — text, a tool call, a stop reason, usage — or an
 * HTTP error, or a stream that HANGS after its first event until the request
 * is aborted. Every request body the SDK sent is kept, parsed, so a test can
 * assert what left the process.
 */

export interface Usage {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
}

export type FakeTurn =
    | { kind: 'text'; text: string; stopReason?: string; usage?: Usage; stopDetails?: Record<string, unknown> }
    | { kind: 'tool'; name: string; input: unknown; usage?: Usage }
    | { kind: 'http-error'; status: number; type: string }
    | { kind: 'hang'; usage?: Usage }
    /** A text answer held back until `gate` resolves: a call kept in flight on purpose. */
    | { kind: 'gated'; gate: Promise<void>; text: string; usage?: Usage };

export interface FakeAnthropic {
    readonly fetch: typeof fetch;
    /** Every request body the SDK sent, parsed. */
    readonly requests: Array<Record<string, unknown>>;
    /** Every request's headers. */
    readonly headers: Headers[];
    /** Every request's URL. */
    readonly urls: string[];
}

const DEFAULT_USAGE: Usage = { input_tokens: 1_000, output_tokens: 200 };

function sse(events: Array<Record<string, unknown>>): string {
    return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function messageStart(model: string, usage: Usage): Record<string, unknown> {
    return {
        type: 'message_start',
        message: {
            id: 'msg_fake',
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { ...usage, output_tokens: 1 },
        },
    };
}

function eventsFor(turn: Exclude<FakeTurn, { kind: 'http-error' } | { kind: 'hang' } | { kind: 'gated' }>, model: string): string {
    const usage = turn.usage ?? DEFAULT_USAGE;
    const body: Array<Record<string, unknown>> = [messageStart(model, usage)];
    if (turn.kind === 'text') {
        body.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        // Two chunks, so the stream really is assembled from deltas.
        const half = Math.floor(turn.text.length / 2);
        for (const chunk of [turn.text.slice(0, half), turn.text.slice(half)]) {
            body.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } });
        }
        body.push({ type: 'content_block_stop', index: 0 });
    } else {
        body.push({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_fake', name: turn.name, input: {} },
        });
        body.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.input) } });
        body.push({ type: 'content_block_stop', index: 0 });
    }
    const stopReason = turn.kind === 'text' ? (turn.stopReason ?? 'end_turn') : 'tool_use';
    body.push({
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null, ...(turn.kind === 'text' && turn.stopDetails ? { stop_details: turn.stopDetails } : {}) },
        usage: { output_tokens: usage.output_tokens },
    });
    body.push({ type: 'message_stop' });
    return sse(body);
}

/** A fake API answering the scripted turns in order; past the script, a 500. */
export function fakeAnthropic(turns: readonly FakeTurn[]): FakeAnthropic {
    const requests: Array<Record<string, unknown>> = [];
    const headers: Headers[] = [];
    const urls: string[] = [];
    let next = 0;

    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        urls.push(url);
        headers.push(new Headers(init?.headers));
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        requests.push(body);
        const model = typeof body.model === 'string' ? body.model : 'unknown-model';
        const turn = turns[next++];
        if (!turn) return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'unscripted' } }), { status: 500 });
        if (turn.kind === 'http-error') {
            return new Response(JSON.stringify({ type: 'error', error: { type: turn.type, message: 'fake' } }), {
                status: turn.status,
                headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
            });
        }
        if (turn.kind === 'gated') {
            await turn.gate;
            return new Response(eventsFor({ kind: 'text', text: turn.text, usage: turn.usage }, model), {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
            });
        }
        if (turn.kind === 'hang') {
            const signal = init?.signal;
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(sse([messageStart(model, turn.usage ?? DEFAULT_USAGE)])));
                    const stop = () => controller.error(signal?.reason ?? new Error('aborted'));
                    if (signal?.aborted) stop();
                    else signal?.addEventListener('abort', stop, { once: true });
                },
            });
            return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        return new Response(eventsFor(turn, model), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    return { fetch: fakeFetch as typeof fetch, requests, headers, urls };
}

/** The key the fake API is called with. Not a credential: the fake answers any key. */
export const FAKE_API_KEY_VALUE = 'fake-anthropic-key-for-tests'; // pragma: allowlist secret

/** Set the fake key in the process env (the env mock answers from it); returns the undo. */
export function setFakeApiKey(): () => void {
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = FAKE_API_KEY_VALUE;
    return () => {
        if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = before;
    };
}
