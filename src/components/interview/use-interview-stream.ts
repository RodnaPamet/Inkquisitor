'use client';

/**
 * The client half of an interview round's stream (Phase 2.4). Lifted from
 * inflect-compliance's `src/components/assistant/use-assistant-stream.ts` (see
 * docs/carve-manifest.md): `fetch` and a reader rather than `EventSource`, the
 * pure reducer exported for the rendered tests, frames split on a blank line
 * with the tail kept, a stream that ends without `done` still ending the turn,
 * and a stop that settles the turn itself. What changed is the events: the
 * question engine's (`src/lib/interview/stream-events.ts`), and the state they
 * build — the round's planned fields, its drafts, and the committed interview.
 *
 * ═══ WHY `fetch` + A READER, NOT `EventSource` ═══
 *
 * `EventSource` only GETs and reconnects on its own. A round is a POST, and a
 * reconnect would start a SECOND round generation (a second claim, more
 * tokens) with no sign to the author. One request, one round.
 *
 * ═══ DRAFTS ARE NOT QUESTIONS ═══
 *
 * A `draft` is shown read-only and has no id. `committed` replaces every draft
 * with the round as the database holds it; only those questions can be
 * answered.
 */
import { useCallback, useRef, useState } from 'react';
import { parseSseData, type DraftQuestion, type InterviewStreamEvent, type PlannedField } from '@/lib/interview/stream-events';
import type { InterviewView } from '@/lib/interview/api-client';

export interface RoundStreamState {
    /** What the page says it is doing. A silent pause reads as a hang. */
    phase: 'idle' | 'connecting' | 'planning' | 'thinking' | 'checking' | 'done';
    /** A new session's id, as soon as its row exists. */
    sessionId: string | null;
    roundNumber: number | null;
    /** The fields the round targets (ids and keys), before any wording arrives. */
    targets: readonly PlannedField[];
    /** The generation call in flight, n of m. */
    call: { n: number; of: number } | null;
    /** Validated candidates, read-only until `committed` replaces them. */
    drafts: ReadonlyArray<{ draftId: string; question: DraftQuestion }>;
    /** The interview as stored after the request: the round opened, or the session ended or paused. */
    committed: InterviewView | null;
    /** A refusal after the stream began, as a code the page words. */
    refusal: string | null;
    /** A refusal before it began (the route's JSON error), or a transport failure (`status` 0). */
    error: { status: number; reason: string | null } | null;
    /** The stream ended with nothing at all (a dropped connection, not an empty round). */
    connectionClosed: boolean;
    /** The author cancelled. */
    stopped: boolean;
}

export const IDLE_STREAM: RoundStreamState = {
    phase: 'idle',
    sessionId: null,
    roundNumber: null,
    targets: [],
    call: null,
    drafts: [],
    committed: null,
    refusal: null,
    error: null,
    connectionClosed: false,
    stopped: false,
};

/** Apply one event. Pure, so the rendered tests drive every event without a server. */
export function applyInterviewEvent(state: RoundStreamState, event: InterviewStreamEvent): RoundStreamState {
    switch (event.type) {
        case 'started':
            return { ...state, sessionId: event.sessionId };
        case 'planned':
            return { ...state, phase: 'planning', roundNumber: event.roundNumber, targets: event.targets };
        case 'thinking':
            return { ...state, phase: 'thinking', call: { n: event.call, of: event.calls } };
        case 'draft':
            return { ...state, phase: 'thinking', drafts: [...state.drafts, { draftId: event.draftId, question: event.question }] };
        case 'checking':
            return { ...state, phase: 'checking', call: null };
        case 'committed':
            // The round as stored replaces every draft.
            return { ...state, committed: event.interview, drafts: [] };
        case 'refusal':
            return { ...state, refusal: event.reason, drafts: [] };
        case 'done':
            return { ...state, phase: 'done', call: null };
        default:
            // An event this client does not know: ignored, so the server may add one.
            return state;
    }
}

/** The reason a JSON refusal names (`error.details.reason`), or null. */
async function reasonOfResponse(res: Response): Promise<string | null> {
    try {
        const body: unknown = await res.json();
        const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error?.details?.reason;
        return typeof reason === 'string' ? reason : null;
    } catch {
        return null;
    }
}

/**
 * One round's stream at a time. `run` starts one (cancelling any before it),
 * `cancel` stops it — the server then abandons the round and frees the model
 * call — and settles the state as stopped. `onEvent` hears each event of the
 * live stream as it is applied (the page takes a new session's id from it).
 */
export function useInterviewStream() {
    const [state, setState] = useState<RoundStreamState>(IDLE_STREAM);
    const abortRef = useRef<AbortController | null>(null);
    const liveRef = useRef(0);

    const cancel = useCallback(() => {
        const abort = abortRef.current;
        abortRef.current = null;
        if (!abort) return;
        abort.abort();
        liveRef.current += 1;
        // Settled here: an aborted read is not an error, so nothing else would end the turn.
        setState((s) => (s.phase === 'done' ? s : { ...s, phase: 'done', call: null, drafts: [], stopped: true }));
    }, []);

    const run = useCallback(
        async (url: string, body: unknown, onEvent?: (event: InterviewStreamEvent) => void): Promise<RoundStreamState> => {
            cancel();
            const abort = new AbortController();
            abortRef.current = abort;
            const turn = ++liveRef.current;
            let local: RoundStreamState = { ...IDLE_STREAM, phase: 'connecting' };
            const update = (fn: (s: RoundStreamState) => RoundStreamState) => {
                if (liveRef.current !== turn) return;
                local = fn(local);
                setState(local);
            };
            setState(local);

            let res: Response;
            try {
                res = await fetch(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body ?? {}),
                    credentials: 'same-origin',
                    cache: 'no-store',
                    signal: abort.signal,
                });
            } catch {
                if (!abort.signal.aborted) update((s) => ({ ...s, phase: 'done', error: { status: 0, reason: null } }));
                return local;
            }
            if (!res.ok || res.body === null) {
                const reason = await reasonOfResponse(res);
                update((s) => ({ ...s, phase: 'done', error: { status: res.status, reason } }));
                if (abortRef.current === abort) abortRef.current = null;
                return local;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let sawEvent = false;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    // Frames end with a blank line; the tail may be half a frame.
                    const frames = buffer.split('\n\n');
                    buffer = frames.pop() ?? '';
                    for (const frame of frames) {
                        const event = parseSseData(frame);
                        if (event === null) continue;
                        sawEvent = true;
                        update((s) => applyInterviewEvent(s, event));
                        if (liveRef.current === turn) onEvent?.(event);
                    }
                }
            } catch {
                if (!abort.signal.aborted) update((s) => ({ ...s, phase: 'done', error: { status: 0, reason: null } }));
            } finally {
                if (abortRef.current === abort) abortRef.current = null;
                // A stream that ended without `done` still ends the turn.
                update((s) => (s.phase === 'done' ? s : { ...s, phase: 'done', call: null, connectionClosed: !sawEvent || (s.committed === null && s.refusal === null) }));
            }
            return local;
        },
        [cancel],
    );

    const reset = useCallback(() => {
        cancel();
        setState(IDLE_STREAM);
    }, [cancel]);

    const busy = state.phase !== 'idle' && state.phase !== 'done';
    return { state, busy, run, cancel, reset };
}
