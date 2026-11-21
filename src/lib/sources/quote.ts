/**
 * THE SPAN CHECK (Phase 4.0, rule 2 applied to facts): a fact counts only
 * when the words it quotes are found, by code, in the chunk it was drawn
 * from — and the span it cites is where they are. Pure.
 *
 * Like the research citation check (`quoteFound`), the quote and the chunk
 * are compared after the same folding on both sides — Unicode NFKC, case,
 * curly quotes and dashes made plain, invisible characters dropped, runs of
 * whitespace one space — and the quote must occur as ONE contiguous run.
 * Unlike it, the match is mapped BACK to the chunk's own characters, so the
 * stored span is exactly the chunk's text from `start` to `end` (what is
 * stored as the fact's quote is that slice, never the model's spelling of it).
 */
import { stripInvisible } from '@/lib/text/invisible-chars';

/** A quote shorter than this (folded) could match by chance: refused. */
export const FACT_QUOTE_MIN_CHARS = 12;
/** A quote is a span, not a page. */
export const FACT_QUOTE_MAX_CHARS = 600;

const FOLDS: Readonly<Record<string, string>> = {
    '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '`': "'", '´': "'",
    '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', '«': '"', '»': '"',
    '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
    '…': '...',
};

interface Folded {
    text: string;
    /** For each character of `text`, the index of the original character it came from. */
    origin: number[];
}

/** `text` folded, with the origin of every folded character. */
export function foldWithOrigins(text: string): Folded {
    let out = '';
    const origin: number[] = [];
    let lastSpace = true;
    for (let i = 0; i < text.length; ) {
        const cp = text.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        const width = ch.length;
        let folded = FOLDS[ch] ?? stripInvisible(ch).normalize('NFKC').toLowerCase();
        if (/^\s+$/.test(folded)) folded = ' ';
        for (const f of folded) {
            if (f === ' ') {
                if (lastSpace) continue;
                lastSpace = true;
            } else lastSpace = false;
            out += f;
            for (let k = 0; k < f.length; k++) origin.push(i);
        }
        i += width;
    }
    // Trailing space carries no meaning.
    while (out.endsWith(' ')) {
        out = out.slice(0, -1);
        origin.pop();
    }
    return { text: out, origin };
}

/** Where `quote` is in `chunk` (the check above), as offsets into `chunk`, or null. */
export function locateQuote(quote: string, chunk: string): { start: number; end: number } | null {
    const q = foldWithOrigins(quote.trim()).text;
    if (q.length < FACT_QUOTE_MIN_CHARS || q.length > FACT_QUOTE_MAX_CHARS * 2) return null;
    const c = foldWithOrigins(chunk);
    const at = c.text.indexOf(q);
    if (at < 0) return null;
    const start = c.origin[at];
    const lastOrigin = c.origin[at + q.length - 1];
    const end = lastOrigin + String.fromCodePoint(chunk.codePointAt(lastOrigin)!).length;
    return { start, end };
}
