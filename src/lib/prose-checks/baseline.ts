/**
 * The overused-words baseline (Phase 5.2, D34): the book's own word
 * frequencies, read from every scene's plain text (bounded by
 * `PROSE_BASELINE_TEXT_MAX_CHARS`; a cut is named) and kept as the stem counts
 * of its `PROSE_BASELINE_STEMS_MAX` most frequent content words. Pure.
 *
 * It is author-derived (a list of the book's words), so the worker stores it
 * only ENCRYPTED (`ProseBookBaseline.baseline`), recomputes it when it is older
 * than `PROSE_BASELINE_MAX_AGE_MS`, and never logs it.
 */
import { createAnalyzer } from '@/lib/search/analyse';
import { isContentWord } from './rules/original';
import type { WordBaseline } from './rules/types';
import { PROSE_BASELINE_STEMS_MAX, PROSE_BASELINE_TEXT_MAX_CHARS } from './vocabulary';

export interface BuiltBaseline extends WordBaseline {
    scenesRead: number;
    cut: boolean;
}

export function buildBaseline(texts: Iterable<string>, maxChars = PROSE_BASELINE_TEXT_MAX_CHARS, stemsMax = PROSE_BASELINE_STEMS_MAX): BuiltBaseline {
    const analyzer = createAnalyzer('en');
    const counts = new Map<string, number>();
    let total = 0;
    let chars = 0;
    let scenes = 0;
    let cut = false;
    for (const text of texts) {
        if (chars + text.length > maxChars) {
            cut = true;
            break;
        }
        chars += text.length;
        scenes++;
        for (const t of analyzer.tokenise(text)) {
            total++;
            if (!isContentWord(t)) continue;
            counts.set(t.stem, (counts.get(t.stem) ?? 0) + 1);
        }
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const kept = sorted.slice(0, stemsMax);
    const minKept = sorted.length > stemsMax ? (kept[kept.length - 1]?.[1] ?? 0) : 0;
    return { totalWords: total, counts: Object.fromEntries(kept), minKept, scenesRead: scenes, cut };
}

/** The stored form (a JSON string, encrypted by the caller's write) and back; a value that does not read is no baseline. */
export function serialiseBaseline(b: WordBaseline): string {
    return JSON.stringify({ v: 1, totalWords: b.totalWords, minKept: b.minKept, counts: b.counts });
}

export function parseBaseline(raw: string | null | undefined): WordBaseline | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw) as { v?: unknown; totalWords?: unknown; minKept?: unknown; counts?: unknown };
        if (v.v !== 1 || typeof v.totalWords !== 'number' || typeof v.minKept !== 'number' || typeof v.counts !== 'object' || v.counts === null) return null;
        const counts: Record<string, number> = {};
        for (const [k, n] of Object.entries(v.counts as Record<string, unknown>)) {
            if (typeof n === 'number' && Number.isFinite(n) && k.length <= 64) counts[k] = n;
        }
        return { totalWords: v.totalWords, minKept: v.minKept, counts };
    } catch {
        return null;
    }
}
