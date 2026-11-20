/**
 * What a research run's progress stream emits (Phase 2.6), on the lifted SSE
 * contract of 2.4 (`src/lib/interview/stream-events.ts`, itself
 * inflect-compliance's): `data: <json>\n\n` frames with no `event:` field, the
 * client switching on the payload's own `type`; an opening comment and an
 * unref'd heartbeat; a refusal named by a code; `done` last.
 *
 * A run is a background job, so the stream OBSERVES it: the route reads the
 * run's stored progress (a phase and counts, never text) about once a second
 * and emits it when it changes, then the finished run, then `done`. Closing
 * the stream stops the reading, never the run.
 *
 *   · `progress`  — the phase (searching, reading, drafting findings, fitting,
 *                   saving) and the counts so far;
 *   · `finished`  — the run as stored once it has ended (status, outcome);
 *   · `refusal`   — the stream could not go on (a code);
 *   · `done`      — the stream is over (the run may still be going, if the
 *                   stream's own bound was reached: the page opens it again).
 *
 * Client-safe: types only from the usecases.
 */
import type { RunView } from '@/app-layer/usecases/research-pages';
import type { RunProgress } from './vocabulary';

export type ResearchStreamEvent =
    | { readonly type: 'progress'; readonly progress: RunProgress }
    | { readonly type: 'finished'; readonly run: RunView }
    | { readonly type: 'refusal'; readonly reason: string }
    | { readonly type: 'done' };

export function researchSseData(event: ResearchStreamEvent): string {
    return `data: ${JSON.stringify(event)}\n\n`;
}

/** Parse one frame's `data:` payload; null for anything unreadable. */
export function parseResearchSse(block: string): ResearchStreamEvent | null {
    const lines = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
    if (lines.length === 0) return null;
    try {
        const parsed: unknown = JSON.parse(lines.join('\n'));
        if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') return null;
        return parsed as ResearchStreamEvent;
    } catch {
        return null;
    }
}
