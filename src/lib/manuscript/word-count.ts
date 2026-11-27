/**
 * Words in a scene (Phase 5.1): Intl.Segmenter's word segments that are
 * word-like (letters or numbers; punctuation and spaces are not words), so
 * "don't" is one word and "well-known" two, in every language the runtime
 * segments (D12: English first). One linear pass over the text.
 *
 * Client-safe (no imports): the editor counts what the author types with the
 * very function the server counts a save with (`countSceneWords` over the
 * stored HTML's plain text, `scene-html.ts`), so the live count and the stored
 * one agree.
 */

let segmenter: Intl.Segmenter | null = null;

function wordSegmenter(): Intl.Segmenter {
    if (!segmenter) segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    return segmenter;
}

/** The words in a plain text. */
export function countWords(text: string): number {
    if (text.trim() === '') return 0;
    let n = 0;
    for (const s of wordSegmenter().segment(text)) if (s.isWordLike) n++;
    return n;
}

/** Words written in a session: the net change since the session began, never below zero (a cut is not negative progress). */
export function sessionProgress(baseline: number, current: number): number {
    return Math.max(0, current - baseline);
}
