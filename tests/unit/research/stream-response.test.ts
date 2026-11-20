/**
 * The research run's progress stream holds a stream slot (2.H item 4) for its
 * whole life and frees it however it ends: the run finishing, the client
 * leaving, or a refusal of the first read.
 */
import { NotFoundError } from '@/lib/errors/types';
import { __resetStreamCapacity, MAX_STREAMS_PER_WORKSPACE, streamCapacitySnapshot } from '@/lib/http/stream-capacity';
import { researchStreamResponse } from '@/lib/research/stream-response';
import type { RunView } from '@/app-layer/usecases/research-pages';

const run = (status: RunView['status']): RunView => ({ id: 'r1', status, progress: { phase: 'SEARCHING' } }) as unknown as RunView;
const req = (signal?: AbortSignal) => new Request('http://x/stream', { signal });
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => __resetStreamCapacity());

describe('researchStreamResponse and stream capacity', () => {
    it('a finished run streams to done and frees its slot', async () => {
        const res = await researchStreamResponse(req(), async () => run('DONE'), { workspaceId: 'w' });
        await res.text();
        expect(streamCapacitySnapshot().total).toBe(0);
    });

    it('a client that leaves frees the slot; the run is not touched', async () => {
        const abort = new AbortController();
        const res = await researchStreamResponse(req(abort.signal), async () => run('RUNNING'), { workspaceId: 'w', pollMs: 5 });
        expect(streamCapacitySnapshot().total).toBe(1);
        abort.abort();
        await tick();
        expect(streamCapacitySnapshot().total).toBe(0);
        await res.body?.cancel().catch(() => {});
    });

    it('a refused first read frees the slot; a full workspace is a 429 before anything is read', async () => {
        await expect(
            researchStreamResponse(req(), async () => {
                throw new NotFoundError('gone');
            }, { workspaceId: 'w' }),
        ).rejects.toBeInstanceOf(NotFoundError);
        expect(streamCapacitySnapshot().total).toBe(0);

        const aborts = Array.from({ length: MAX_STREAMS_PER_WORKSPACE }, () => new AbortController());
        await Promise.all(aborts.map((a) => researchStreamResponse(req(a.signal), async () => run('RUNNING'), { workspaceId: 'w', pollMs: 5 })));
        let reads = 0;
        await expect(
            researchStreamResponse(req(), async () => {
                reads++;
                return run('RUNNING');
            }, { workspaceId: 'w' }),
        ).rejects.toMatchObject({ status: 429, details: { reason: 'STREAM_CAPACITY' } });
        expect(reads).toBe(0);
        for (const a of aborts) a.abort();
        await tick();
        expect(streamCapacitySnapshot().total).toBe(0);
    });
});
