/**
 * THE QUERY EGRESS CHECK (Phase 2.6, decision D9): "queries are written from
 * the research brief and never carry manuscript or bible text".
 *
 * A research run sends text OUT of the product in two ways: the search queries
 * and the page URLs the model hands Anthropic's server-side web tools (which
 * pass them to the search provider and to the page's own site). This module
 * judges one such text against the book's STORED text (every element's name,
 * summary and field values, decrypted for the run and never kept):
 *
 *   QUOTES_BOOK_TEXT   the text shares a run of `SHINGLE_WORDS` consecutive
 *                      words, at least `SHINGLE_CONTENT_WORDS` of them content
 *                      words, with the book's stored text: a quotation, not a
 *                      topic. A single word (a character's name, a real
 *                      place) is not a quote: the brief may name its subject.
 *   CARRIES_SECRET     2.1's egress scanner finds a secret shape in it.
 *
 * WHERE IT RUNS, and what each place can promise:
 *
 *   1. the brief, when it is written and again when its run starts: the
 *      question, the purpose and every attached URL — refused before anything
 *      is sent (`BRIEF_QUOTES_BIBLE`). This is a GATE.
 *   2. the gather request: it carries the brief and NOTHING ELSE of the book
 *      (no bible text, no manuscript), so the model writing the queries holds
 *      no stored text to quote. This is the guarantee D9 rests on.
 *   3. every web_search query and web_fetch URL (its host as well as its path,
 *      query and fragment) the model issues, as the
 *      stream completes it: a refusal stops the run (`QUERY_REFUSED`). The
 *      provider runs a server tool itself, so the query may already have left
 *      by the time it is read here: this is a TRIPWIRE that records and stops,
 *      not a gate (see `src/lib/ai/server-tool-loop.ts`).
 *
 * Pure. No text is logged; a refusal is a code.
 */
import { scanEgress } from '@/lib/ai/guard';
import { groundingForm } from '@/lib/enrichment/validate';
import { normaliseText, STOP_WORDS, words } from '@/lib/interview/text';

/** A quotation is this many consecutive words in common. */
export const SHINGLE_WORDS = 4;
/** …of which at least this many are content words (not stop words, three letters or more). */
export const SHINGLE_CONTENT_WORDS = 2;
/** The book text indexed at most, characters (a bound on the run's memory, not a sample: past it the check refuses everything). */
export const INDEX_TEXT_MAX_CHARS = 4_000_000;

export type EgressRefusal = 'QUOTES_BOOK_TEXT' | 'CARRIES_SECRET' | 'INDEX_INCOMPLETE';

export interface BookTextIndex {
    readonly shingles: ReadonlySet<string>;
    /** True when the book's text passed `INDEX_TEXT_MAX_CHARS`: the check then refuses every text, never vouching unseen. */
    readonly incomplete: boolean;
}

const isContent = (w: string): boolean => w.length >= 3 && !STOP_WORDS.has(w);

/** Percent-decoding rounds at most (a double-encoded `%2520` takes two). */
export const PERCENT_DECODE_ROUNDS = 4;

const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/**
 * Every `%XX` run decoded on its own, round after round until nothing changes:
 * a malformed escape elsewhere in the text (`%zz`, a lone `%E2`) must not stop
 * the rest from being decoded, or one stray `%` would hide a quotation spelt
 * with `%20` between its words. A run that is not UTF-8 reads as a space.
 */
export function percentDecoded(text: string): string {
    let current = text.replace(/\+/g, ' ');
    for (let round = 0; round < PERCENT_DECODE_ROUNDS; round++) {
        const next = current.replace(PERCENT_RUN, (run) => {
            try {
                return decodeURIComponent(run);
            } catch {
                return ' ';
            }
        });
        if (next === current) break;
        current = next;
    }
    return current;
}

/** The words of a text as the check compares them (a URL's host, path and query decoded and split at punctuation). */
export function egressWords(text: string): string[] {
    const decoded = percentDecoded(text);
    // Apostrophes made one and a possessive read as its name (2.5's grounding form), so a curly quote cannot hide a quotation.
    return words(groundingForm(normaliseText(decoded.replace(/[_\-./?=&#:%@]+/g, ' '))));
}

function shinglesOf(ws: readonly string[], into: Set<string>): void {
    for (let i = 0; i + SHINGLE_WORDS <= ws.length; i++) {
        const run = ws.slice(i, i + SHINGLE_WORDS);
        if (run.filter(isContent).length < SHINGLE_CONTENT_WORDS) continue;
        into.add(run.join(' '));
    }
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"']+/gi;

/**
 * Index the book's stored text (each entry one value: a name, a summary, a
 * field's text). Web addresses written IN the bible (a research note's
 * sources) are left out: they are where facts came from, not the story, and
 * indexing them would refuse every later page of the same site.
 */
export function buildBookTextIndex(texts: readonly string[]): BookTextIndex {
    const shingles = new Set<string>();
    let chars = 0;
    for (const t of texts) {
        chars += t.length;
        if (chars > INDEX_TEXT_MAX_CHARS) return { shingles, incomplete: true };
        shinglesOf(egressWords(t.replace(URL_IN_TEXT, ' ')), shingles);
    }
    return { shingles, incomplete: false };
}

/**
 * The forms of an outgoing text the check reads: the text as written, and for
 * a web address also as the URL parser reads it (its host, path, query and
 * fragment, dot segments resolved). The HOST is read too: a host name is sent
 * to the resolver and to the site, so a subdomain spelt from the book's text
 * (`the-butler-poisoned-lady-ashworth.example.com`) carries it out as surely
 * as a path does.
 */
function checkedForms(text: string): string[] {
    const trimmed = text.trim();
    if (!/^https?:\/\//i.test(trimmed)) return [text];
    try {
        const u = new URL(trimmed);
        return [text, `${u.hostname} ${u.pathname} ${u.search} ${u.hash}`];
    } catch {
        return [text];
    }
}

/** Why `text` may not leave the product, or null. */
export function outgoingTextRefusal(text: string, index: BookTextIndex): EgressRefusal | null {
    if (index.incomplete) return 'INDEX_INCOMPLETE';
    if (scanEgress(text).verdict !== 'clean') return 'CARRIES_SECRET';
    for (const form of checkedForms(text)) {
        const own = new Set<string>();
        shinglesOf(egressWords(form), own);
        for (const s of own) if (index.shingles.has(s)) return 'QUOTES_BOOK_TEXT';
    }
    return null;
}

/**
 * The tripwire's judgement of one server tool use: a web_search's `query`, a
 * web_fetch's `url`. Anything else (another tool, an input without the
 * expected string) is refused: the gather request offers no other tool.
 */
export function toolUseRefusal(use: { tool: string; input: unknown }, index: BookTextIndex): string | null {
    const input = use.input as { query?: unknown; url?: unknown } | null;
    if (use.tool === 'web_search') {
        if (typeof input?.query !== 'string') return 'UNREADABLE_TOOL_INPUT';
        return outgoingTextRefusal(input.query, index);
    }
    if (use.tool === 'web_fetch') {
        if (typeof input?.url !== 'string') return 'UNREADABLE_TOOL_INPUT';
        return outgoingTextRefusal(input.url, index);
    }
    return 'TOOL_NOT_PERMITTED';
}
