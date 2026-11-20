/**
 * A search query, parsed (Phase 3.4, decision D21). Pure.
 *
 *   words            unquoted words are OPTIONAL terms matched by stem: an
 *                    element matches when it holds at least one of them, and
 *                    ranks by how many and how well (`rank.ts`)
 *   "a phrase"       a quoted run of words is REQUIRED and matched by surface
 *                    form, in sequence: an element must hold every phrase
 *   Capitalised      a capitalised unquoted word also asks for its exact case,
 *                    as a ranking signal ("Hope" ranks the name above the noun)
 *
 * Straight and curly double quotes both delimit a phrase. An unbalanced quote
 * is ignored: the words after it are ordinary words. An empty pair of quotes
 * is nothing. Stop words (`STOP_WORDS`) are dropped from the unquoted words,
 * unless the query holds nothing else (a search for "the" still searches);
 * a phrase keeps every word. Repeated words count once.
 *
 * BOUNDS (`vocabulary.ts`): the trimmed query is at most
 * `SEARCH_QUERY_MAX_CHARS`, it holds at most `SEARCH_QUERY_MAX_WORDS` words
 * and `SEARCH_QUERY_MAX_PHRASES` phrases; past any, `parseQuery` answers the
 * refusal rather than a cut query, so a search never quietly ignores what
 * the author typed.
 */
import { STOP_WORDS, type Analyzer } from './analyse';
import { SEARCH_QUERY_MAX_CHARS, SEARCH_QUERY_MAX_PHRASES, SEARCH_QUERY_MAX_WORDS, type SearchQueryRefusal } from './vocabulary';

export interface QueryTerm {
    surface: string;
    stem: string;
    /** The case-kept form when the query word is capitalised: an exact-case match ranks higher. */
    exact: string | null;
}

export interface QueryPhrase {
    /** The phrase's words as surface forms, in order (at least two; a one-word phrase is a surface term). */
    surfaces: string[];
}

export interface ParsedQuery {
    terms: QueryTerm[];
    /** Quoted single words: matched by surface form only, and required like a phrase. */
    exactWords: string[];
    phrases: QueryPhrase[];
    /** Nothing to search for. */
    empty: boolean;
}

export type QueryParse = { ok: true; query: ParsedQuery } | { ok: false; reason: SearchQueryRefusal };

const QUOTES = new Set(['"', '“', '”', '„', '‟', '＂']);

/** The query cut into unquoted and quoted runs. An unbalanced last quote leaves its run unquoted. */
export function splitQuoted(input: string): Array<{ quoted: boolean; text: string }> {
    const runs: Array<{ quoted: boolean; text: string }> = [];
    let current = '';
    let inQuote = false;
    for (const ch of input) {
        if (QUOTES.has(ch)) {
            runs.push({ quoted: inQuote, text: current });
            current = '';
            inQuote = !inQuote;
            continue;
        }
        current += ch;
    }
    // An unclosed quote: what followed it is ordinary words.
    runs.push({ quoted: false, text: current });
    return runs.filter((r) => r.text.trim() !== '');
}

export function parseQuery(raw: string, analyzer: Analyzer): QueryParse {
    const input = raw.trim();
    if (input.length > SEARCH_QUERY_MAX_CHARS) return { ok: false, reason: 'QUERY_TOO_LONG' };

    const unquoted: QueryTerm[] = [];
    const exactWords: string[] = [];
    const phrases: QueryPhrase[] = [];
    let words = 0;
    for (const run of splitQuoted(input)) {
        const tokens = analyzer.tokenise(run.text, 'name');
        words += tokens.length;
        if (run.quoted) {
            if (tokens.length === 1) exactWords.push(tokens[0].surface);
            else if (tokens.length > 1) phrases.push({ surfaces: tokens.map((t) => t.surface) });
        } else {
            for (const t of tokens) unquoted.push({ surface: t.surface, stem: t.stem, exact: t.exact });
        }
    }
    if (words > SEARCH_QUERY_MAX_WORDS) return { ok: false, reason: 'QUERY_TOO_MANY_TERMS' };
    if (phrases.length + exactWords.length > SEARCH_QUERY_MAX_PHRASES) return { ok: false, reason: 'QUERY_TOO_MANY_PHRASES' };

    const contentful = analyzer.language === 'en' ? unquoted.filter((t) => !STOP_WORDS.has(t.surface)) : unquoted;
    const kept = contentful.length > 0 || phrases.length > 0 || exactWords.length > 0 ? contentful : unquoted;
    const seen = new Set<string>();
    const terms = kept.filter((t) => {
        const key = `${t.stem}\u0000${t.surface}\u0000${t.exact ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    const uniqueExact = [...new Set(exactWords)];
    const phraseKeys = new Set<string>();
    const uniquePhrases = phrases.filter((p) => {
        const key = p.surfaces.join(' ');
        if (phraseKeys.has(key)) return false;
        phraseKeys.add(key);
        return true;
    });
    return { ok: true, query: { terms, exactWords: uniqueExact, phrases: uniquePhrases, empty: terms.length === 0 && uniqueExact.length === 0 && uniquePhrases.length === 0 } };
}
