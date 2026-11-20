/**
 * Shorten a text for display without splitting a character (Phase 3.H, issue
 * #50 item 5): cut between grapheme clusters (`Intl.Segmenter`), never at a
 * UTF-16 index, which can split an emoji's surrogate pair (shown as `�`), a
 * flag's two regional indicators, or a letter from its combining accent.
 * `max` counts user-perceived characters, the ellipsis included. Client-safe.
 */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function truncateGraphemes(text: string, max: number, ellipsis = '…'): string {
    // Fewer code units than `max` is fewer characters: no segmenting.
    if (text.length <= max) return text;
    const kept: string[] = [];
    for (const { segment } of graphemes.segment(text)) {
        if (kept.length === max) return `${kept.slice(0, max - 1).join('')}${ellipsis}`;
        kept.push(segment);
    }
    return text;
}
