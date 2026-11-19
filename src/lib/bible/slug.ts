/**
 * Element slugs: unique per book, URL-safe, derived from the name unless the
 * author gives one. The database holds the same shape (`BibleElement_slug_shape`).
 */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MAX = 80;

/** `s` without leading and trailing hyphens (by index: an anchored `-+$` backtracks on long runs). */
function trimHyphens(s: string): string {
    let start = 0;
    let end = s.length;
    while (start < end && s[start] === '-') start++;
    while (end > start && s[end - 1] === '-') end--;
    return s.slice(start, end);
}

/** Combining diacritical marks, which NFKD splits off an accented letter. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** `"Mara of the Salt Roads"` → `"mara-of-the-salt-roads"`; `""` when nothing usable is left. */
export function slugify(name: string): string {
    const dashed = name.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return trimHyphens(trimHyphens(dashed).slice(0, SLUG_MAX));
}

/**
 * The `n`th candidate for `base`: `base` itself for 1, else `base-n`, the base
 * shortened (at a hyphen-free end) to keep the whole within SLUG_MAX. A long
 * base is shortened for its suffixes, so the stem a candidate is built on is
 * not always `base`: a lookup of what is taken must ask for the candidates
 * themselves (`slugCandidates`), never for slugs starting `base-`.
 */
export function slugCandidate(base: string, n: number): string {
    if (n <= 1) return base;
    const suffix = `-${n}`;
    return `${trimHyphens(base.slice(0, SLUG_MAX - suffix.length))}${suffix}`;
}

/** Candidates `from` … `from + count - 1` for `base`, in order. */
export function slugCandidates(base: string, from: number, count: number): string[] {
    return Array.from({ length: count }, (_, i) => slugCandidate(base, from + i));
}

/** The first candidate for `base` that `taken` does not hold. */
export function firstFreeSlug(base: string, taken: ReadonlySet<string>): string {
    for (let n = 1; ; n++) {
        const candidate = slugCandidate(base, n);
        if (!taken.has(candidate)) return candidate;
    }
}
