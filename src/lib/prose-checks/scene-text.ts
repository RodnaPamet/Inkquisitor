/**
 * A scene's text as the prose checks read it (Phase 5.2, D34). Server-only.
 *
 * THE PLAIN TEXT is 3.4's `HtmlTextReader` over the stored TipTap HTML, and
 * nothing else: lines joined by `\n`, a break between blocks, runs of space
 * collapsed, a mention read as its `@Name`. Every finding's offsets are into
 * that text, so the editor — which rebuilds the same text from its own
 * document (`./editor-map.ts`) — can map them back to positions, and the read
 * usecase can hand the editor the text each finding covered to check against.
 *
 * ITALIC RUNS are found beside it, never by re-deriving the text: a second
 * pass over the same HTML records each character the parser reports and
 * whether it sits inside an `em`/`i` element, and its NON-SPACE characters are
 * matched one for one with the plain text's (the reader only collapses and
 * adds space, never changes or reorders anything else). A mismatch — which
 * would mean the two passes read different text — yields no italic runs at
 * all, so the tense and person checks read the italics as narration rather
 * than skip text they should not.
 *
 * MENTION RUNS are found the same way (a `span[data-mention]`): a mention's
 * `@Name` is a bible element's name, not the author's prose, so the engine
 * raises no note on it (but similar names) and never offers a suggestion that
 * would cover it — in the editor it is one atom, and replacing part of it
 * would replace the whole mention. A mismatch yields no mention runs; the
 * editor refuses such a suggestion again on its side.
 */
import { Parser } from 'htmlparser2';
import { HtmlTextReader } from '@/lib/search/plain-text';

export interface TextRange {
    start: number;
    end: number;
}

export interface SceneProseText {
    text: string;
    /** Italic runs (thought and emphasis), offsets into `text`, sorted and disjoint. */
    italics: TextRange[];
    /** Mentions (`@Name`, a bible element's name), offsets into `text`, sorted and disjoint. */
    mentions: TextRange[];
}

const NON_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style', 'template', 'noscript', 'textarea', 'iframe', 'object', 'embed', 'svg', 'math']);
const ITALIC_ELEMENTS: ReadonlySet<string> = new Set(['em', 'i']);
const SPACE = /\s/;

interface CharStream {
    chars: string;
    /** Per UTF-16 unit of `chars`: inside an italic element, inside a mention span. */
    italic: boolean[];
    mention: boolean[];
}

/** Every character the parser reports outside non-text elements, and whether it is inside an italic element or a mention. */
function charStream(html: string): CharStream {
    let skipping = 0;
    let italicDepth = 0;
    let mentionDepth = 0;
    // Whether each open span is a mention (a span closes the span it opened).
    const spans: boolean[] = [];
    let chars = '';
    const italic: boolean[] = [];
    const mention: boolean[] = [];
    const parser = new Parser(
        {
            onopentag(name, attribs) {
                if (NON_TEXT_ELEMENTS.has(name)) skipping++;
                else if (ITALIC_ELEMENTS.has(name)) italicDepth++;
                else if (name === 'span') {
                    const isMention = attribs['data-mention'] !== undefined;
                    spans.push(isMention);
                    if (isMention) mentionDepth++;
                }
            },
            onclosetag(name) {
                if (NON_TEXT_ELEMENTS.has(name)) skipping = Math.max(0, skipping - 1);
                else if (ITALIC_ELEMENTS.has(name)) italicDepth = Math.max(0, italicDepth - 1);
                else if (name === 'span' && spans.pop() === true) mentionDepth = Math.max(0, mentionDepth - 1);
            },
            ontext(text) {
                if (skipping > 0) return;
                for (const c of text) {
                    // A code point may be two UTF-16 units: one flag per unit keeps indices aligned with `chars`.
                    chars += c;
                    for (let k = 0; k < c.length; k++) {
                        italic.push(italicDepth > 0);
                        mention.push(mentionDepth > 0);
                    }
                }
            },
        },
        { decodeEntities: true, lowerCaseTags: true },
    );
    parser.parseComplete(html);
    return { chars, italic, mention };
}

/** The runs of `text` whose characters the stream flags, by matching its non-space characters with the stream's; [] when they disagree. */
function flaggedRuns(text: string, stream: CharStream, flagOf: (stream: CharStream, j: number) => boolean): TextRange[] {
    const flags: Array<boolean | null> = new Array(text.length).fill(null);
    let j = 0;
    for (let i = 0; i < text.length; i++) {
        if (SPACE.test(text[i])) continue;
        while (j < stream.chars.length && SPACE.test(stream.chars[j])) j++;
        if (j >= stream.chars.length || stream.chars[j] !== text[i]) return [];
        flags[i] = flagOf(stream, j);
        j++;
    }
    while (j < stream.chars.length && SPACE.test(stream.chars[j])) j++;
    if (j !== stream.chars.length) return [];
    // A run spans from its first italic character to its last, the spaces between included; a line break ends it.
    const runs: TextRange[] = [];
    let open: number | null = null;
    let lastItalic = -1;
    for (let i = 0; i < text.length; i++) {
        const f = flags[i];
        if (text[i] === '\n') {
            if (open !== null) runs.push({ start: open, end: lastItalic + 1 });
            open = null;
            continue;
        }
        if (f === null) continue;
        if (f) {
            if (open === null) open = i;
            lastItalic = i;
        } else if (open !== null) {
            runs.push({ start: open, end: lastItalic + 1 });
            open = null;
        }
    }
    if (open !== null) runs.push({ start: open, end: lastItalic + 1 });
    return runs;
}

/** The scene's plain text, its italic runs and its mentions. */
export function sceneProseText(html: string, reader: HtmlTextReader = new HtmlTextReader()): SceneProseText {
    if (html === '') return { text: '', italics: [], mentions: [] };
    const text = reader.read(html);
    const stream = charStream(html);
    return { text, italics: flaggedRuns(text, stream, (st, j) => st.italic[j]), mentions: flaggedRuns(text, stream, (st, j) => st.mention[j]) };
}

/**
 * The text cut to at most `max` characters, at the last line break before the
 * bound (or the bound itself when the first line alone passes it), and whether
 * it was cut: a check of a very long scene reads its beginning and says so.
 */
export function boundText(text: string, max: number): { text: string; cut: boolean } {
    if (text.length <= max) return { text, cut: false };
    const nl = text.lastIndexOf('\n', max);
    let end = nl > 0 ? nl : max;
    // Never between the two halves of a surrogate pair.
    if (nl <= 0 && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end -= 1;
    return { text: text.slice(0, end), cut: true };
}
