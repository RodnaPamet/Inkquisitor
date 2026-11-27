/**
 * A SCENE'S PIECES AND THE CALLS THEY ARE SENT IN (Phase 5.3; rule 9, the per-call budget ENFORCED). Pure: the caller
 * hands it the worst-case function (`draftReadCallWorstCase`).
 *
 *   1. The scene's plain text (3.4's reader, `sceneProseText`) is read up to `DRAFT_TEXT_MAX_CHARS`; past it the rest
 *      is unread and the cut is NAMED (`cut`), never silent.
 *   2. It is cut into pieces of at most `maxChars` at paragraph, sentence or space boundaries (4.1's `cutText`), each
 *      piece keeping its OFFSET into the whole text, so every quote it yields is placed in the scene.
 *   3. A piece whose call's worst case is past the budget is HALVED, down to `minChars`; then the book's names and the
 *      threads are dropped; a piece that still does not fit refuses the whole scene (`CALL_OVER_BUDGET`): nothing is
 *      sent for it, and it is passed over until its text changes.
 */
import type { AuthorDataBlock } from '@/lib/ai/prompt';
import { cutText } from '@/lib/facts/entry-text';
import { draftReadBlocks, type ShownDraftThread } from './prompt';

export interface ScenePiece {
    readonly text: string;
    readonly offset: number;
}

export interface PlannedDraftCall {
    readonly piece: ScenePiece;
    readonly blocks: AuthorDataBlock[];
    readonly worstMicroUsd: number;
    /** How many threads it was shown (0 once it shed context). */
    readonly threadsShown: number;
}

export type DraftCallPlan = { ok: true; calls: PlannedDraftCall[]; cut: boolean } | { ok: false; reason: 'CALL_OVER_BUDGET'; worstMicroUsd: number; cut: boolean };

/** The paragraph breaks of a plain text (`\n`), as offsets `cutText` prefers to cut at. */
function breaksOf(text: string): number[] {
    const out: number[] = [];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) out.push(i + 1);
    return out;
}

/** A text cut into pieces of at most `max` characters, each with its offset into `text` (exact: `text.slice(offset, offset + piece.length) === piece`). */
export function piecesOf(text: string, max: number, base = 0): ScenePiece[] {
    const out: ScenePiece[] = [];
    let from = 0;
    for (const run of cutText(text, breaksOf(text), max)) {
        const at = text.indexOf(run.text, from);
        if (at < 0) continue;
        out.push({ text: run.text, offset: base + at });
        from = at + run.text.length;
    }
    return out;
}

export function planDraftCalls(input: {
    text: string;
    textMax: number;
    headings: readonly string[];
    bookNames: readonly string[];
    threads: readonly ShownDraftThread[];
    budgetMicroUsd: number;
    maxChars: number;
    minChars: number;
    worst: (blocks: readonly AuthorDataBlock[]) => number;
}): DraftCallPlan {
    const cut = input.text.length > input.textMax;
    const text = cut ? input.text.slice(0, input.textMax) : input.text;
    const queue: ScenePiece[] = piecesOf(text, input.maxChars);
    const calls: PlannedDraftCall[] = [];
    const shape = (piece: ScenePiece, context: boolean): PlannedDraftCall => {
        const threads = context ? input.threads : [];
        const blocks = draftReadBlocks({ text: piece.text, headings: input.headings, bookNames: context ? input.bookNames : [], threads });
        return { piece, blocks, worstMicroUsd: input.worst(blocks), threadsShown: threads.length };
    };
    let smallest = Number.POSITIVE_INFINITY;
    while (queue.length > 0) {
        const piece = queue.shift()!;
        const full = shape(piece, true);
        if (full.worstMicroUsd <= input.budgetMicroUsd) {
            calls.push(full);
            continue;
        }
        if (piece.text.length > input.minChars) {
            const halves = piecesOf(piece.text, Math.max(input.minChars, Math.ceil(piece.text.length / 2)), piece.offset);
            if (halves.length > 1) {
                queue.unshift(...halves);
                continue;
            }
        }
        const bare = shape(piece, false);
        smallest = Math.min(smallest, bare.worstMicroUsd);
        if (bare.worstMicroUsd > input.budgetMicroUsd) return { ok: false, reason: 'CALL_OVER_BUDGET', worstMicroUsd: smallest, cut };
        calls.push(bare);
    }
    return { ok: true, calls, cut };
}
