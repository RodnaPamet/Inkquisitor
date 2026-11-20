/**
 * The transport half of an interview round's stream (Phase 2.4): one usecase
 * run, turned into a `text/event-stream` response of `InterviewStreamEvent`s.
 * Server-only. The transport shape is inflect-compliance's assistant stream
 * route's (see docs/carve-manifest.md): the opening comment (a client sees
 * the stream open before the first event), the heartbeat (unref'd: it keeps a
 * connection warm and never a process alive), `safe` writes once the client
 * has gone, idempotent cleanup, and `X-Accel-Buffering: no` so a proxy does
 * not hold the bytes back.
 *
 * ═══ REFUSALS BEFORE THE STREAM, EVENTS AFTER IT ═══
 *
 * The run is started at once, and the response waits for the FIRST of: the
 * run saying it is under way (`sink.ready()`: the round is claimed, or a new
 * session exists), or the run settling. A run that throws before it is under
 * way — a permission refused inside the usecase, 409 ROUND_OPEN, 503
 * AI_UNAVAILABLE, a 400 — rethrows here, so the route answers the ordinary
 * JSON error (`withApiErrorHandling`) and nothing was written. Once under way,
 * the outcome is an event: `committed` with the stored interview, or
 * `refusal` with a code, and always `done` last.
 *
 * ═══ CANCELLATION FREES THE SERVER (2.H item 4) ═══
 *
 * The client going away (the request's signal, or the reader cancelling)
 * aborts the run's signal, which the usecase hands to the model call in
 * flight: the provider's fetch is cut, no further call is made, and the round
 * is abandoned (FAILED, its tokens charged; the session stays resumable). The
 * round's persistence stays one transaction: a cancelled round writes no
 * question.
 *
 * Nothing here logs the events: they carry author text.
 */
import { AppError, RateLimitedError } from '@/lib/errors/types';
import { acquireStreamSlot, type CapacityLease } from '@/lib/http/stream-capacity';
import { logger } from '@/lib/observability/logger';
import { sseComment, sseData, type InterviewStreamEvent } from './stream-events';
import type { InterviewView } from '@/app-layer/usecases/interview-state';

/** Matches inflect's notifications and assistant streams, tuned against the same proxies. */
export const HEARTBEAT_INTERVAL_MS = 25_000;

export interface StreamSink {
    emit(event: InterviewStreamEvent): void;
    /** The run is under way: the response is sent now, and later failures are events. */
    ready(): void;
    /** Aborted when the client goes away. */
    readonly signal: AbortSignal;
}

const encoder = new TextEncoder();

/** A refusal's code: the usecase's named `details.reason`, else the error's code, else INTERNAL. Never a message. */
export function refusalCodeOf(err: unknown): string {
    if (err instanceof AppError) {
        const reason = (err.details as { reason?: unknown } | undefined)?.reason;
        return typeof reason === 'string' ? reason : err.code;
    }
    return 'INTERNAL';
}

/**
 * Take the workspace's stream slot (`src/lib/http/stream-capacity.ts`, 2.H
 * item 4), or refuse 429 `STREAM_CAPACITY` naming the binding bound, before
 * anything runs or is written. Shared with the research progress stream.
 */
export function takeStreamSlot(workspaceId: string): CapacityLease {
    const lease = acquireStreamSlot(workspaceId);
    if (typeof lease === 'string') throw new RateLimitedError('Too many streams are open.', { reason: 'STREAM_CAPACITY', bound: lease });
    return lease;
}

export async function interviewStreamResponse(
    req: Request,
    run: (sink: StreamSink) => Promise<InterviewView>,
    opts: { workspaceId: string },
): Promise<Response> {
    // The slot is held until the run settles AND the stream is torn down,
    // whichever is later, and released exactly once (`release` is idempotent).
    const lease = takeStreamSlot(opts.workspaceId);
    const abort = new AbortController();
    const onClientGone = () => abort.abort();
    if (req.signal.aborted) abort.abort();
    else req.signal.addEventListener('abort', onClientGone, { once: true });

    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    const pending: string[] = [];
    const write = (chunk: string) => {
        if (closed) return;
        if (!controller) {
            pending.push(chunk);
            return;
        }
        try {
            controller.enqueue(encoder.encode(chunk));
        } catch {
            // Torn down mid-flush: the client went away between the check and the write.
            closed = true;
        }
    };

    let markReady: () => void = () => {};
    const ready = new Promise<'ready'>((resolve) => {
        markReady = () => resolve('ready');
    });
    const sink: StreamSink = { emit: (event) => write(sseData(event)), ready: () => markReady(), signal: abort.signal };
    let work: Promise<InterviewView>;
    try {
        work = run(sink);
    } catch (err) {
        lease.release();
        req.signal.removeEventListener('abort', onClientGone);
        throw err;
    }
    // The run's own end frees nothing while the stream may still be writing;
    // a run that settles before the stream starts is released by the stream's
    // cleanup, or below when it refused before the stream existed.
    const settled = work.then(
        () => undefined,
        () => undefined,
    );

    // A throw before the run is under way is the route's ordinary JSON error.
    try {
        await Promise.race([ready, work]);
    } catch (err) {
        lease.release();
        req.signal.removeEventListener('abort', onClientGone);
        throw err;
    }

    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const cleanup = () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        req.signal.removeEventListener('abort', onClientGone);
        // The slot goes when the run has settled too: a cancelled run is still
        // cutting its model call and abandoning its round until it settles.
        void settled.then(() => lease.release());
        if (closed) return;
        closed = true;
        try {
            controller?.close();
        } catch {
            // Already closed upstream.
        }
    };

    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c;
            write(sseComment('connected'));
            for (const chunk of pending.splice(0)) write(chunk);
            heartbeat = setInterval(() => write(sseComment('hb')), HEARTBEAT_INTERVAL_MS);
            heartbeat.unref?.();
            void work
                .then(
                    (interview) => write(sseData({ type: 'committed', interview })),
                    (err: unknown) => {
                        if (!(err instanceof AppError)) {
                            logger.error('interview.stream_failed', { component: 'interview', error: err instanceof Error ? err.name : 'unknown' });
                        }
                        write(sseData({ type: 'refusal', reason: refusalCodeOf(err) }));
                    },
                )
                .finally(() => {
                    write(sseData({ type: 'done' }));
                    cleanup();
                });
        },
        cancel() {
            // The reader let go without the request's own abort.
            abort.abort();
            cleanup();
        },
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            Connection: 'keep-alive',
        },
    });
}
