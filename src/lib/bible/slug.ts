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
 * The first of `base`, `base-2`, `base-3`, … that `taken` does not hold, each
 * kept within SLUG_MAX by shortening the base.
 */
export function firstFreeSlug(base: string, taken: ReadonlySet<string>): string {
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
        const suffix = `-${n}`;
        const candidate = `${trimHyphens(base.slice(0, SLUG_MAX - suffix.length))}${suffix}`;
        if (!taken.has(candidate)) return candidate;
    }
}
