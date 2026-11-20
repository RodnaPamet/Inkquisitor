'use client';

/**
 * The client half of a research run's progress stream (Phase 2.6), on 2.4's
 * lifted pattern (`use-interview-stream.ts`): `fetch` and a reader, frames
 * split on a blank line with the tail kept, the pure reducer exported for the
 * rendered tests. The stream only OBSERVES a background run, so a dropped or
 * bounded stream is simply opened again while the run is live; closing it
 * never stops the run.
 */
import { useEffect, useRef, useState } from 'react';
import { parseResearchSse, type ResearchStreamEvent } from '@/lib/research/stream-events';
import { EMPTY_PROGRESS, type RunProgress } from '@/lib/research/vocabulary';
import type { RunView } from '@/lib/research/api-client';

export interface ResearchStreamState {
    progress: RunProgress;
    finished: RunView | null;
    refusal: string | null;
}

export const INITIAL_RESEARCH_STREAM: ResearchStreamState = { progress: EMPTY_PROGRESS, finished: null, refusal: null };

/** Apply one event. Pure. */
export function applyResearchEvent(state: ResearchStreamState, event: ResearchStreamEvent): ResearchStreamState {
    switch (event.type) {
        case 'progress':
            return { ...state, progress: event.progress };
        case 'finished':
            return { ...state, progress: event.run.progress, finished: event.run };
        case 'refusal':
            return { ...state, refusal: event.reason };
        case 'done':
            return state;
    }
}

/**
 * Read a run's stream until it finishes, opening it again when it ends early
 * (a dropped connection, the stream's own bound). Module level, so the hook's
 * effect only subscribes.
 */
async function followRun(target: string, signal: AbortSignal, onEvent: (e: ResearchStreamEvent) => void, onFinished: (run: RunView) => void): Promise<void> {
    for (let attempt = 0; attempt < 20 && !signal.aborted; attempt++) {
        let finished: RunView | null = null;
        try {
            const res = await fetch(target, { credentials: 'same-origin', cache: 'no-store', signal });
            if (!res.ok || !res.body) {
                onEvent({ type: 'refusal', reason: 'STREAM_UNAVAILABLE' });
                return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const frames = buffer.split('\n\n');
                buffer = frames.pop() ?? '';
                for (const frame of frames) {
                    const event = parseResearchSse(frame);
                    if (!event) continue;
                    if (event.type === 'finished') finished = event.run;
                    onEvent(event);
                }
            }
        } catch {
            if (signal.aborted) return;
        }
        if (finished) {
            onFinished(finished);
            return;
        }
        await new Promise((r) => setTimeout(r, 1_000));
    }
}

/** Follow a live run's progress until it finishes; `onFinished` once it has. */
export function useResearchStream(url: string | null, onFinished: (run: RunView) => void): ResearchStreamState {
    // The state is keyed by the stream it came from, so a new run starts from nothing without a reset in the effect.
    const [keyed, setKeyed] = useState<{ url: string | null; state: ResearchStreamState }>({ url: null, state: INITIAL_RESEARCH_STREAM });
    const finishedRef = useRef(onFinished);
    useEffect(() => {
        finishedRef.current = onFinished;
    });
    useEffect(() => {
        if (!url) return;
        const abort = new AbortController();
        const onEvent = (event: ResearchStreamEvent) => setKeyed((prev) => ({ url, state: applyResearchEvent(prev.url === url ? prev.state : INITIAL_RESEARCH_STREAM, event) }));
        void followRun(url, abort.signal, onEvent, (run) => finishedRef.current(run));
        return () => abort.abort();
    }, [url]);
    return keyed.url === url ? keyed.state : INITIAL_RESEARCH_STREAM;
}
