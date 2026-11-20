/**
 * What an interview round's stream emits, and why each event exists (Phase
 * 2.4). Lifted from inflect-compliance's `src/app-layer/ai/assistant/
 * stream-events.ts` (see docs/carve-manifest.md): the wire format and the rule
 * that a silent pause reads as a hang are kept; the events are the question
 * engine's.
 *
 * ═══ A QUESTION SHOWN BEFORE COMMIT IS A DRAFT ═══
 *
 * 2.2 persists a round under the session's lock AFTER generation, in one
 * transaction: nothing of a round exists until all of it does. The stream does
 * not change that. While the model words the round, the author is shown
 * DRAFTS — each call's candidates once code has validated them — read-only,
 * with no id and no control; deduplication, the pack fallback and the persist
 * may still drop or renumber them. Only `committed` carries the round as the
 * database holds it (ids, positions, recommendations), and only its questions
 * can be answered: the client replaces every draft with it.
 *
 *   · `started`    — a new session's row exists (start only): its id, so the
 *                    page can be reloaded or resumed even if the stream drops;
 *   · `planned`    — the round is claimed, and WHICH fields it targets (ids and
 *                    keys, no text): the side panel fills in before any wording;
 *   · `thinking`   — a generation call is in flight (n of m). A bare spinner
 *                    does not say what is being waited for;
 *   · `draft`      — a validated candidate, not yet the round's;
 *   · `checking`   — the calls are done; code is deduplicating and saving;
 *   · `committed`  — the interview as stored after this request: the round
 *                    opened, or the session ended or paused with its reason;
 *   · `refusal`    — the request failed after the stream began, with a CODE
 *                    the page words. An empty stream that ends is
 *                    indistinguishable from a crash;
 *   · `done`       — the turn is over.
 *
 * A refusal before the stream begins (403, 409 ROUND_OPEN, 503
 * AI_UNAVAILABLE, …) is not an event: the route answers it as an ordinary JSON
 * error with `details.reason`, as every other route does.
 *
 * Client-safe: types only from the usecases.
 */
import type { InterviewView } from '@/app-layer/usecases/interview-state';
import type { QuestionKind, QuestionMode } from './vocabulary';

/** A candidate shown while the round is being worded. Never answerable. */
export interface DraftQuestion {
    elementId: string;
    targetsFieldKeys: string[];
    mode: QuestionMode;
    kind: QuestionKind;
    text: string;
    options: string[] | null;
    scaleLabels: { low: string; high: string } | null;
    personaKey: string | null;
    reviewRequired: boolean;
}

/** A field a round targets: an element's keys, no text. */
export interface PlannedField {
    elementId: string;
    fieldKey: string;
}

export type InterviewStreamEvent =
    | { readonly type: 'started'; readonly sessionId: string }
    | { readonly type: 'planned'; readonly roundNumber: number; readonly targets: readonly PlannedField[] }
    | { readonly type: 'thinking'; readonly call: number; readonly calls: number }
    | { readonly type: 'draft'; readonly draftId: string; readonly question: DraftQuestion }
    | { readonly type: 'checking' }
    | { readonly type: 'committed'; readonly interview: InterviewView }
    | { readonly type: 'refusal'; readonly reason: string }
    | { readonly type: 'done' };

/**
 * SSE wire format, as inflect's: `data: <json>\n\n` with no `event:` field —
 * the client switches on the payload's own `type`, so an event added later
 * does not need a channel an older client never subscribed to.
 */
export function sseData(event: InterviewStreamEvent): string {
    return `data: ${JSON.stringify(event)}\n\n`;
}

/** An SSE comment: invisible to a consumer, used for the opening byte and the heartbeat. */
export function sseComment(text: string): string {
    return `: ${text}\n\n`;
}

/** Parse one SSE frame's `data:` payload; null for anything unreadable (a half frame loses one event, not the turn). */
export function parseSseData(block: string): InterviewStreamEvent | null {
    const dataLines = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return null;
    try {
        const parsed: unknown = JSON.parse(dataLines.join('\n'));
        if (typeof parsed !== 'object' || parsed === null) return null;
        if (typeof (parsed as { type?: unknown }).type !== 'string') return null;
        return parsed as InterviewStreamEvent;
    } catch {
        return null;
    }
}
