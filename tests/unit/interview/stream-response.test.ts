/**
 * The interview round's stream (Phase 2.4): the SSE contract lifted from
 * inflect (`stream-events.ts`) and its transport (`stream-response.ts`):
 * refusals before the stream are the route's JSON error, events after it are
 * frames ending in `done`, and the client going away aborts the run.
 */
import { ConflictError } from '@/lib/errors/types';
import { interviewStreamResponse, refusalCodeOf } from '@/lib/interview/stream-response';
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

    it('names a refusal by its usecase reason, else its code, else INTERNAL — never a message', () => {
        expect(refusalCodeOf(new ConflictError('x', { reason: 'ROUND_OPEN' }))).toBe('ROUND_OPEN');
        expect(refusalCodeOf(new ConflictError('x'))).toBe('CONFLICT');
        expect(refusalCodeOf(new Error('secret text'))).toBe('INTERNAL');
    });
});

describe('interviewStreamResponse', () => {
    const req = (signal?: AbortSignal) => new Request('http://x/stream', { method: 'POST', signal });

    it('rethrows a failure before the run is under way, so the route answers JSON', async () => {
        await expect(interviewStreamResponse(req(), async () => Promise.reject(new ConflictError('open', { reason: 'ROUND_OPEN' })))).rejects.toMatchObject({ details: { reason: 'ROUND_OPEN' } });
    });

    it('streams what the run emits, then committed, then done', async () => {
        const res = await interviewStreamResponse(req(), async (sink) => {
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
        const res = await interviewStreamResponse(req(), async () => VIEW);
        expect(framesOf(await res.text()).map((e) => e.type)).toEqual(['committed', 'done']);
    });

    it('a failure after the stream began is a refusal event with its code, then done', async () => {
        const res = await interviewStreamResponse(req(), async (sink) => {
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
        const res = await interviewStreamResponse(req(abort.signal), async (sink) => {
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
        const res2 = await interviewStreamResponse(req(), async (sink) => {
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
