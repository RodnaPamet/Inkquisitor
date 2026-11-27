/**
 * THE DIALOGUE DETECTOR (Phase 5.2, D34 item 2): which stretches of a scene's
 * plain text are SPEECH, read from the style sheet's speech marks. Narration
 * rules (filter words, tense and person slips, the inclusive-language check,
 * openers, intensifiers, wordiness, clichés) never read inside a speech range.
 *
 * It works one line (paragraph) at a time and is deliberately simple; what it
 * does and where it stops:
 *
 *   double      “ opens and ” closes; a straight " toggles. A paragraph whose
 *               speech is never closed is speech to its end (the convention for
 *               speech running on into the next paragraph, which opens again).
 *   single      ‘ opens; ’ closes only when no letter follows it (so "don’t"
 *               stays inside); a straight ' opens only before a letter and after
 *               the line's start, a space or an opening bracket or dash, and
 *               closes only after a non-space with no letter after it. A plural
 *               possessive inside speech ("the dogs’ bowl") closes it early:
 *               the rest of that speech reads as narration.
 *   guillemets  « opens and » closes; ‹ and › likewise.
 *   dash        a paragraph opening with an em dash, a horizontal bar or a
 *               spaced en dash is speech to its end, narration tags inside it
 *               included (the detector does not split "— Yes, she said —").
 *   none        nothing is speech: every word is narration (so the narration
 *               rules read speech too; the settings say so).
 *   no sheet    double marks, single marks (curly and straight, read as under
 *               `single`) and guillemets: with nothing to say which a book uses,
 *               more is taken as speech, so the narration rules stay quiet on
 *               it rather than read a character's words as narration.
 *
 * Speech ranges include their marks. Italic runs are NOT speech here (the
 * tense and person checks skip them separately).
 */
import type { StyleQuoteMarks } from './vocabulary';
import type { TextRange } from './scene-text';

const LETTER = /[\p{L}\p{N}]/u;
const OPENING_CONTEXT = /[\s([{—–\-"“«‹]/;

function isLetter(c: string | undefined): boolean {
    return c !== undefined && LETTER.test(c);
}

/** Speech ranges of one line (offsets relative to the line). */
function lineSpeech(line: string, style: StyleQuoteMarks | null): TextRange[] {
    if (style === 'none') return [];
    if (style === 'dash') {
        const lead = line.length - line.trimStart().length;
        const c = line[lead];
        const spacedEnDash = c === '–' && line[lead + 1] === ' ';
        return c === '—' || c === '―' || spacedEnDash ? [{ start: lead, end: line.length }] : [];
    }
    const double = style === null || style === 'double';
    const curlySingle = style === null || style === 'single';
    const straightSingle = style === null || style === 'single';
    const guillemets = style === null || style === 'guillemets';
    const out: TextRange[] = [];
    let open: number | null = null;
    let closer: 'double' | 'single' | 'guillemet' | 'single-guillemet' | null = null;
    const close = (end: number) => {
        if (open !== null) out.push({ start: open, end });
        open = null;
        closer = null;
    };
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (open === null) {
            if (double && (c === '“' || c === '"')) {
                open = i;
                closer = 'double';
            } else if (curlySingle && c === '‘') {
                open = i;
                closer = 'single';
            } else if (straightSingle && c === "'" && isLetter(line[i + 1]) && (i === 0 || OPENING_CONTEXT.test(line[i - 1]))) {
                open = i;
                closer = 'single';
            } else if (guillemets && c === '«') {
                open = i;
                closer = 'guillemet';
            } else if (guillemets && c === '‹') {
                open = i;
                closer = 'single-guillemet';
            }
            continue;
        }
        if (closer === 'double' && (c === '”' || c === '"')) close(i + 1);
        else if (closer === 'single' && (c === '’' || (straightSingle && c === "'")) && !isLetter(line[i + 1]) && i > 0 && line[i - 1] !== ' ') close(i + 1);
        else if (closer === 'guillemet' && c === '»') close(i + 1);
        else if (closer === 'single-guillemet' && c === '›') close(i + 1);
    }
    // Speech left open runs to the paragraph's end (it continues in the next one).
    if (open !== null) close(line.length);
    return out;
}

/** The speech ranges of a scene's plain text, sorted and disjoint (offsets into `text`). */
export function speechRanges(text: string, style: StyleQuoteMarks | null): TextRange[] {
    const out: TextRange[] = [];
    let base = 0;
    for (const line of text.split('\n')) {
        for (const r of lineSpeech(line, style)) out.push({ start: base + r.start, end: base + r.end });
        base += line.length + 1;
    }
    return out;
}

/**
 * A sorted, disjoint range list asked "does [start, end) touch any range?" in
 * O(log n) a question (the rules ask once a token).
 */
export class RangeSet {
    private readonly starts: number[];
    private readonly ends: number[];

    constructor(ranges: readonly TextRange[]) {
        const sorted = [...ranges].sort((a, b) => a.start - b.start);
        this.starts = sorted.map((r) => r.start);
        this.ends = sorted.map((r) => r.end);
    }

    get size(): number {
        return this.starts.length;
    }

    /** Does [start, end) overlap a range? */
    overlaps(start: number, end: number): boolean {
        // The last range starting before `end`.
        let lo = 0;
        let hi = this.starts.length - 1;
        let found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.starts[mid] < end) {
                found = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        return found >= 0 && this.ends[found] > start;
    }

    /** Is the position inside a range? */
    contains(pos: number): boolean {
        return this.overlaps(pos, pos + 1);
    }
}
