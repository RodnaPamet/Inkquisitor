/**
 * The transport of a research run's progress stream (Phase 2.6): the run's
 * stored state read every `POLL_MS`, emitted as `ResearchStreamEvent`s on the
 * lifted SSE transport's shape (`src/lib/interview/stream-response.ts`): the
 * opening comment, the unref'd heartbeat, safe writes once the client has
 * gone, idempotent cleanup, `X-Accel-Buffering: no`. Server-only.
 *
 * The first read happens BEFORE the response: a refusal there (a run of
 * another book, a reader removed) is the route's ordinary JSON error. The
 * stream ends with `done` when the run ends, when the client leaves, or after
 * `STREAM_MAX_MS` (the page opens it again). It reads; it never stops a run.
 */
import { sseComment } from '@/lib/interview/stream-events';
import { HEARTBEAT_INTERVAL_MS, refusalCodeOf, takeStreamSlot } from '@/lib/interview/stream-response';
import type { RunView } from '@/app-layer/usecases/research-pages';
import { researchSseData, type ResearchStreamEvent } from './stream-events';

export const POLL_MS = 1_000;
export const STREAM_MAX_MS = 10 * 60_000;

const encoder = new TextEncoder();
const terminal = (r: RunView) => r.status !== 'QUEUED' && r.status !== 'RUNNING';

export async function researchStreamResponse(
    req: Request,
    read: () => Promise<RunView>,
    opts: { workspaceId: string; pollMs?: number; maxMs?: number },
): Promise<Response> {
    const pollMs = opts.pollMs ?? POLL_MS;
    const maxMs = opts.maxMs ?? STREAM_MAX_MS;
    // The workspace's stream slot (2.H item 4), held until the stream ends however it ends.
    const lease = takeStreamSlot(opts.workspaceId);
    let first: RunView;
    try {
        first = await read();
    } catch (err) {
        lease.release();
        throw err;
    }
    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const write = (chunk: string) => {
        if (closed || !controller) return;
        try {
            controller.enqueue(encoder.encode(chunk));
        } catch {
            closed = true;
        }
    };
    const emit = (e: ResearchStreamEvent) => write(researchSseData(e));
    const cleanup = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (timer) clearTimeout(timer);
        heartbeat = null;
        timer = null;
        req.signal.removeEventListener('abort', cleanup);
        lease.release();
        if (closed) return;
        closed = true;
        try {
            controller?.close();
        } catch {
            // already closed
        }
    };
    const end = () => {
        emit({ type: 'done' });
        cleanup();
    };
    req.signal.addEventListener('abort', cleanup, { once: true });
    const startedAt = Date.now();
    let last = '';
    const step = (run: RunView) => {
        const key = JSON.stringify(run.progress);
        if (key !== last) {
            last = key;
            emit({ type: 'progress', progress: run.progress });
        }
        if (terminal(run)) {
            emit({ type: 'finished', run });
            return end();
        }
        if (Date.now() - startedAt >= maxMs) return end();
        timer = setTimeout(() => {
            if (closed) return;
            read().then(step, (err: unknown) => {
                emit({ type: 'refusal', reason: refusalCodeOf(err) });
                end();
            });
        }, pollMs);
        timer.unref?.();
    };
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c;
            write(sseComment('connected'));
            heartbeat = setInterval(() => write(sseComment('hb')), HEARTBEAT_INTERVAL_MS);
            heartbeat.unref?.();
            step(first);
        },
        cancel() {
            cleanup();
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' },
    });
}
