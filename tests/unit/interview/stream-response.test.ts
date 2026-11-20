/**
 * The interview round's stream (Phase 2.4): the SSE contract lifted from
 * inflect (`stream-events.ts`) and its transport (`stream-response.ts`):
 * refusals before the stream are the route's JSON error, events after it are
 * frames ending in `done`, and the client going away aborts the run.
 */
import { ConflictError } from '@/lib/errors/types';
import { interviewStreamResponse, refusalCodeOf } from '@/lib/interview/stream-response';
import { __resetStreamCapacity, MAX_STREAMS_GLOBAL, MAX_STREAMS_PER_WORKSPACE, streamCapacitySnapshot } from '@/lib/http/stream-capacity';
import { RateLimitedError } from '@/lib/errors/types';
import { parseSseData, sseComment, sseData, type InterviewStreamEvent } from '@/lib/interview/stream-events';
import type { InterviewView } from '@/app-layer/usecases/interview-state';

const VIEW = { session: { id: 's1' } } as unknown as InterviewView;

function framesOf(text: string): InterviewStreamEvent[] {
    return text
        .split('\n\n')
        .map(parseSseData)
        .filter((e): e is InterviewStreamEvent => e !== null);
}

describe('the wire format', () => {
    it('round-trips an event and ignores a comment, a half frame and a payload with no type', () => {
        const event: InterviewStreamEvent = { type: 'planned', roundNumber: 2, targets: [{ elementId: 'e', fieldKey: 'want' }] };
        expect(parseSseData(sseData(event).trim())).toEqual(event);
        expect(parseSseData(sseComment('hb').trim())).toBeNull();
        expect(parseSseData('data: {"type":"dra')).toBeNull();
        expect(parseSseData('data: {"kind":"x"}')).toBeNull();
    });

    it('author text cannot break the framing: newlines, a blank line and a `data:` line in a question stay inside one event', () => {
        const hostile = 'What does she want?\n\ndata: {"type":"done"}\n\r\n: hb\n\nevent: refusal';
        const draft: InterviewStreamEvent = {
            type: 'draft',
            draftId: 'draft-1',
            question: { elementId: 'e', targetsFieldKeys: ['want'], mode: 'FRONTIER', kind: 'OPEN', text: hostile, options: [hostile], scaleLabels: null, personaKey: null, reviewRequired: false },
        };
        const wire = sseData(draft) + sseData({ type: 'done' });
        // One frame per event, whatever the text holds.
        expect(wire.split('\n\n').filter((f) => f !== '')).toHaveLength(2);
        expect(framesOf(wire)).toEqual([draft, { type: 'done' }]);
    });

    it('names a refusal by its usecase reason, else its code, else INTERNAL — never a message', () => {
        expect(refusalCodeOf(new ConflictError('x', { reason: 'ROUND_OPEN' }))).toBe('ROUND_OPEN');
        expect(refusalCodeOf(new ConflictError('x'))).toBe('CONFLICT');
        expect(refusalCodeOf(new Error('secret text'))).toBe('INTERNAL');
    });
});

const stream = (r: Request, run: Parameters<typeof interviewStreamResponse>[1], workspaceId = 'ws-1') => interviewStreamResponse(r, run, { workspaceId });

beforeEach(() => __resetStreamCapacity());

describe('interviewStreamResponse', () => {
    const req = (signal?: AbortSignal) => new Request('http://x/stream', { method: 'POST', signal });

    it('rethrows a failure before the run is under way, so the route answers JSON', async () => {
        await expect(stream(req(), async () => Promise.reject(new ConflictError('open', { reason: 'ROUND_OPEN' })))).rejects.toMatchObject({ details: { reason: 'ROUND_OPEN' } });
    });

    it('streams what the run emits, then committed, then done', async () => {
        const res = await stream(req(), async (sink) => {
            sink.emit({ type: 'started', sessionId: 's1' });
            sink.ready();
            await Promise.resolve();
            sink.emit({ type: 'checking' });
            return VIEW;
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
        expect(res.headers.get('x-accel-buffering')).toBe('no');
        const text = await res.text();
        expect(text.startsWith(': connected')).toBe(true);
        expect(framesOf(text).map((e) => e.type)).toEqual(['started', 'checking', 'committed', 'done']);
    });

    it('a run that settles without ever being under way still streams its outcome (a session that stopped at once)', async () => {
        const res = await stream(req(), async () => VIEW);
        expect(framesOf(await res.text()).map((e) => e.type)).toEqual(['committed', 'done']);
    });

    it('a failure after the stream began is a refusal event with its code, then done', async () => {
        const res = await stream(req(), async (sink) => {
            sink.ready();
            await Promise.resolve();
            throw new ConflictError('x', { reason: 'INTERVIEW_ENDED' });
        });
        expect(framesOf(await res.text())).toEqual([{ type: 'refusal', reason: 'INTERVIEW_ENDED' }, { type: 'done' }]);
    });

    it('the client going away aborts the run’s signal, and the reader cancelling does too', async () => {
        const abort = new AbortController();
        let seen: AbortSignal | null = null;
        let finish: () => void = () => {};
        const res = await stream(req(abort.signal), async (sink) => {
            seen = sink.signal;
            sink.ready();
            await new Promise<void>((r) => (finish = r));
            return VIEW;
        });
        expect(seen!.aborted).toBe(false);
        abort.abort();
        expect(seen!.aborted).toBe(true);
        finish();

        let seen2: AbortSignal | null = null;
        const res2 = await stream(req(), async (sink) => {
            seen2 = sink.signal;
            sink.ready();
            await new Promise(() => {});
            return VIEW;
        });
        await res2.body!.cancel();
        expect(seen2!.aborted).toBe(true);
        await res.body!.cancel().catch(() => {});
    });
});

describe('stream capacity (2.H item 4; issue #36, item 3)', () => {
    const req = (signal?: AbortSignal) => new Request('http://x/stream', { method: 'POST', signal });
    /** A run that is under way and settles only when `finish` is called (or its signal aborts). */
    function held() {
        let finish: () => void = () => {};
        let signal: AbortSignal | null = null;
        const run = async (sink: { ready(): void; signal: AbortSignal }) => {
            signal = sink.signal;
            sink.ready();
            await new Promise<void>((resolve) => {
                finish = resolve;
                sink.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            return VIEW;
        };
        return { run, finish: () => finish(), signal: () => signal };
    }
    const tick = () => new Promise((r) => setTimeout(r, 0));

    it('a workspace holds at most MAX_STREAMS_PER_WORKSPACE streams; the next is a 429 STREAM_CAPACITY before its run starts; another workspace is unaffected', async () => {
        const runs = Array.from({ length: MAX_STREAMS_PER_WORKSPACE }, held);
        const responses = await Promise.all(runs.map((h) => stream(req(), h.run)));
        expect(streamCapacitySnapshot().workspaces['ws-1']).toBe(MAX_STREAMS_PER_WORKSPACE);
        let started = false;
        const refused = stream(req(), async () => {
            started = true;
            return VIEW;
        });
        await expect(refused).rejects.toBeInstanceOf(RateLimitedError);
        await expect(refused).rejects.toMatchObject({ status: 429, details: { reason: 'STREAM_CAPACITY', bound: 'WORKSPACE_AT_CAPACITY' } });
        expect(started).toBe(false);
        const other = held();
        const elsewhere = await stream(req(), other.run, 'ws-2');
        expect(elsewhere.status).toBe(200);
        // Each stream ending frees its slot.
        for (const h of [...runs, other]) h.finish();
        await Promise.all([...responses, elsewhere].map((r) => r.text()));
        await tick();
        expect(streamCapacitySnapshot()).toEqual({ total: 0, workspaces: {} });
    });

    it('the process holds at most MAX_STREAMS_GLOBAL across workspaces', async () => {
        const runs = Array.from({ length: MAX_STREAMS_GLOBAL }, held);
        const responses = await Promise.all(runs.map((h, i) => stream(req(), h.run, `ws-${i}`)));
        await expect(stream(req(), held().run, 'ws-new')).rejects.toMatchObject({ details: { reason: 'STREAM_CAPACITY', bound: 'PROCESS_AT_CAPACITY' } });
        for (const h of runs) h.finish();
        await Promise.all(responses.map((r) => r.text()));
        await tick();
        expect(streamCapacitySnapshot().total).toBe(0);
    });

    it('cancellation frees the slot: the client going away aborts the run, and once it settles the slot is free', async () => {
        const abort = new AbortController();
        const h = held();
        await stream(req(abort.signal), h.run);
        expect(streamCapacitySnapshot().total).toBe(1);
        abort.abort();
        expect(h.signal()!.aborted).toBe(true);
        await tick();
        expect(streamCapacitySnapshot().total).toBe(0);

        // The reader cancelling, without the request's own abort, does the same.
        const h2 = held();
        const res2 = await stream(req(), h2.run);
        expect(streamCapacitySnapshot().total).toBe(1);
        await res2.body!.cancel();
        await tick();
        expect(h2.signal()!.aborted).toBe(true);
        expect(streamCapacitySnapshot().total).toBe(0);
    });

    it('a cancelled run that is still settling keeps its slot until it settles', async () => {
        let settle: () => void = () => {};
        const res = await stream(req(), async (sink) => {
            sink.ready();
            await new Promise<void>((r) => (settle = r)); // ignores the abort: still cutting its call
            return VIEW;
        });
        await res.body!.cancel();
        await tick();
        expect(streamCapacitySnapshot().total).toBe(1);
        settle();
        await tick();
        expect(streamCapacitySnapshot().total).toBe(0);
    });

    it('a refusal before the stream opened frees the slot at once', async () => {
        await expect(stream(req(), async () => Promise.reject(new RateLimitedError('x')))).rejects.toBeInstanceOf(RateLimitedError);
        expect(streamCapacitySnapshot().total).toBe(0);
        // A run that throws synchronously, too.
        await expect(
            stream(req(), (() => {
                throw new Error('sync');
            }) as unknown as Parameters<typeof interviewStreamResponse>[1]),
        ).rejects.toThrow('sync');
        expect(streamCapacitySnapshot().total).toBe(0);
    });
});
