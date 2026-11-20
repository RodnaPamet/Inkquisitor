/**
 * The sources a research run reads, and the citation check (Phase 2.6, rule 2).
 *
 * A source is what the findings step may cite: a page the gather turn fetched
 * as text (`web.N`), or a file the author attached (`file.N`). Its text is the
 * text the findings call was SHOWN (cut at `SOURCE_TEXT_MAX_CHARS`), so a
 * quote is verified against exactly what the model read.
 *
 * THE CITATION CHECK (`quoteFound`): a quoted span counts only when, after the
 * same normalisation on both sides — Unicode NFKC, look-alike letters folded,
 * curly quotes and dashes made plain, invisible characters dropped, whitespace
 * collapsed, case folded — it occurs in the source's text as one contiguous
 * run. Nothing fuzzier: a span the source does not hold is an unverifiable
 * claim, refused, not softened. The web search tool's own `cited_text` is not
 * used: the search results' page text is encrypted by the provider and never
 * readable here, so a span from a search result could not be checked; only a
 * page the run FETCHED can be cited.
 */
import { normaliseText } from '@/lib/interview/text';

/** A source's text is shown (and checked) up to this many characters. */
export const SOURCE_TEXT_MAX_CHARS = 30_000;
/** A run's findings call reads at most this many sources. */
export const SOURCES_PER_RUN_MAX = 24;
/** A quote shorter than this (normalised) could match by chance: refused. */
export const QUOTE_MIN_CHARS = 20;
/** A quote is a span, not a page: longer is refused at the schema. */
export const QUOTE_MAX_CHARS = 600;

export type SourceKind = 'URL' | 'UPLOAD';

export interface ResearchSourceDoc {
    /** How the findings call names it: `web.1`, `file.2`. */
    readonly ref: string;
    readonly kind: SourceKind;
    /** URL: the page's address. */
    readonly url: string | null;
    /** UPLOAD: the attached file's id. */
    readonly sourceId: string | null;
    readonly title: string | null;
    /** The text shown to the findings call and checked against. */
    readonly text: string;
    /** URL: when the page was retrieved (ISO), if the tool said. */
    readonly retrievedAt: string | null;
}

const QUOTE_FOLDS: ReadonlyArray<[RegExp, string]> = [
    [/[‘’‚‛′`´]/g, "'"],
    [/[“”„‟″«»]/g, '"'],
    [/[‐-―−]/g, '-'],
    [/…/g, '...'],
];

/** Text as the citation check compares it. */
export function citationForm(text: string): string {
    let out = text;
    for (const [re, to] of QUOTE_FOLDS) out = out.replace(re, to);
    return normaliseText(out);
}

/** Does `quote` occur in `sourceText` (the check above)? */
export function quoteFound(quote: string, sourceText: string): boolean {
    const q = citationForm(quote);
    if (q.length < QUOTE_MIN_CHARS) return false;
    return citationForm(sourceText).includes(q);
}

/** A source's text as it is shown: control characters dropped, cut at the bound. */
export function sourceTextOf(raw: string): string {
    return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, SOURCE_TEXT_MAX_CHARS);
}

/** The http(s) URL as written, or null (anything else is not a source the product links to). */
export function webUrlOf(raw: string): string | null {
    try {
        const u = new URL(raw.trim());
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        if (u.username || u.password) return null;
        return u.toString();
    } catch {
        return null;
    }
}
