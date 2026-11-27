/**
 * Ranking a book's documents against a parsed query, in memory (Phase 3.4,
 * decision D21). Pure: the usecase reads and decrypts the book, turns every
 * source into plain text (`plain-text.ts`) and hands the documents here;
 * nothing is stored and nothing outlives the call.
 *
 * DOCUMENTS. One per element (its name, custom label, summary, every stored
 * field and the notes of its relations) and one for the book (its title and
 * logline). A result is a document.
 *
 * SKIPPING. A source is tokenised only when its folded text (`foldText`)
 * contains one of the query's NEEDLES (`candidateNeedles`): for a word, the
 * first characters of its stem (all but the last two: Porter2 never changes
 * more than the last two characters of a stem it keeps — the golden test
 * checks it over Snowball's whole vocabulary) and every irregular form of a
 * lemma with that stem (and the same for a word's REGULAR stem, when the
 * irregular table gave it another: Phase 3.H); for a phrase its first word; for a quoted word the
 * word. Every word's surface form is a substring of its text's folded form,
 * so a skipped source cannot hold a match: skipping changes the work, never
 * the results (`tests/unit/search/rank.test.ts` holds both).
 *
 * MATCHING. A candidate source is tokenised (`analyse.ts`). A token matches an
 * unquoted query word by stem, weighted by how closely (`MATCH_WEIGHTS`):
 * its exact case when the query word is capitalised (1.3), its surface form
 * (1.0), its stem alone (0.6) — so an exact match always beats a stem match,
 * and a capitalised query word prefers the name over the lower-case word
 * without excluding it. A quoted phrase matches surface forms in sequence,
 * within one line of its source (a block: never across a paragraph or a
 * list item, Phase 3.H); a
 * quoted single word matches its surface form. A document matches when it
 * holds every phrase and quoted word, and at least one unquoted word if the
 * query has no phrase.
 *
 * SCORING: BM25F. For a query word t and a document, the weighted term
 * frequency is the sum over its sources of
 *   weight(source class) · Σ match weights / (1 − b + b · length / average length of the class)
 * where a source's length is its count of letter-or-digit runs (`countWords`,
 * taken for every source, skipped or not, so the averages are over the book),
 * (`SOURCE_WEIGHTS`, `SOURCE_LENGTH_NORMALISATION`), saturated as
 * tf / (k1 + tf) and multiplied by t's inverse document frequency over the
 * book's documents, ln(1 + (N − df + 0.5) / (df + 0.5)). Phrases and quoted
 * words are scored the same way as their own terms, times `PHRASE_BOOST`.
 * Ties fall to the name, then the id, so an order is never left to chance.
 *
 * SNIPPETS. Each result names its matched sources, best first, each with a
 * plain-text snippet around its first match and the highlighted ranges in it
 * (offsets into the snippet; `start` places the snippet in the source).
 *
 * WORK is counted (`SearchWork`): sources read and tokenised, words
 * segmented, stems computed, so the performance test bounds the search by
 * counted work and its growth rather than by a wall clock.
 */
import { countWords, foldText, type Analyzer, type Token } from './analyse';
import { IRREGULAR_SURFACES_BY_STEM } from './irregular';
import type { ParsedQuery } from './query';
import {
    BM25_K1,
    MATCH_WEIGHTS,
    PHRASE_BOOST,
    SEARCH_MATCHES_PER_RESULT,
    SNIPPET_LEAD_CHARS,
    SNIPPET_MAX_CHARS,
    SOURCE_LENGTH_NORMALISATION,
    SOURCE_WEIGHTS,
    type SearchHighlight,
    type SearchHitView,
    type SearchMatchView,
    type SearchSnippet,
    type SearchSourceKind,
} from './vocabulary';

export interface SearchSource {
    kind: SearchSourceKind;
    /** Plain text (never HTML). */
    text: string;
    fieldKey?: string | null;
    fieldLabel?: string | null;
    otherElementName?: string | null;
}

export interface SearchDocument {
    kind: 'book' | 'element' | 'scene';
    elementId: string | null;
    /** A scene's id and its chapter's title (Phase 5.H-a); absent otherwise. */
    sceneId?: string | null;
    chapterTitle?: string | null;
    elementKind: string | null;
    name: string;
    customLabel: string | null;
    sources: SearchSource[];
}

export interface SearchWork {
    sourcesRead: number;
    /** Sources that held a needle, and so were tokenised. */
    sourcesTokenised: number;
    wordsSegmented: number;
    stemsComputed: number;
}

export interface RankedSearch {
    hits: SearchHitView[];
    totalHits: number;
    truncated: boolean;
    work: SearchWork;
}

/** Sources whose capitals are names, not sentence starts. */
const NAME_LIKE: ReadonlySet<SearchSourceKind> = new Set(['title', 'name', 'label', 'sceneTitle']);

interface Span {
    start: number;
    end: number;
}

/** One source's matches. */
interface SourceMatch {
    source: SearchSource;
    length: number;
    /** Per unquoted term: the sum of its match weights in this source. */
    termWeights: Map<number, number>;
    /** Per required term (phrases, then quoted words): occurrences in this source. */
    requiredCounts: Map<number, number>;
    spans: Span[];
}

interface DocMatch {
    doc: SearchDocument;
    order: number;
    sources: SourceMatch[];
}

function idf(n: number, df: number): number {
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/** Match one source's tokens against the query. */
function matchSource(source: SearchSource, length: number, tokens: readonly Token[], query: ParsedQuery, index: QueryIndex): SourceMatch | null {
    const termWeights = new Map<number, number>();
    const requiredCounts = new Map<number, number>();
    const spans: Span[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        // By its stem and, for a word the irregular table changed, its regular stem too (Phase 3.H, #48 item 3).
        const byRegular = token.regularStem !== null ? index.termsByStem.get(token.regularStem) : undefined;
        const byPrimary = index.termsByStem.get(token.stem);
        const byStem = byRegular ? [...new Set([...(byPrimary ?? []), ...byRegular])] : byPrimary;
        if (byStem) {
            for (const t of byStem) {
                const term = query.terms[t];
                const weight = term.exact !== null && token.exact === term.exact ? MATCH_WEIGHTS.exactCase : token.surface === term.surface ? MATCH_WEIGHTS.surface : MATCH_WEIGHTS.stem;
                termWeights.set(t, (termWeights.get(t) ?? 0) + weight);
            }
            spans.push({ start: token.start, end: token.end });
        }
        const exactWord = index.exactWordBySurface.get(token.surface);
        if (exactWord !== undefined) {
            requiredCounts.set(exactWord, (requiredCounts.get(exactWord) ?? 0) + 1);
            spans.push({ start: token.start, end: token.end });
        }
        const phrases = index.phrasesByFirstSurface.get(token.surface);
        if (phrases) {
            for (const p of phrases) {
                const words = query.phrases[p].surfaces;
                if (i + words.length > tokens.length) continue;
                let all = true;
                for (let k = 1; k < words.length; k++) {
                    // A phrase never runs across a block (Phase 3.H, #48 item 2): plain text breaks the line between
                    // blocks, so "end start" does not match `<p>end</p><p>Start</p>` or two list items.
                    if (tokens[i + k].surface !== words[k] || source.text.slice(tokens[i + k - 1].end, tokens[i + k].start).includes('\n')) {
                        all = false;
                        break;
                    }
                }
                if (!all) continue;
                requiredCounts.set(p, (requiredCounts.get(p) ?? 0) + 1);
                spans.push({ start: token.start, end: tokens[i + words.length - 1].end });
            }
        }
    }
    if (termWeights.size === 0 && requiredCounts.size === 0) return null;
    return { source, length, termWeights, requiredCounts, spans };
}

interface QueryIndex {
    termsByStem: Map<string, number[]>;
    phrasesByFirstSurface: Map<string, number[]>;
    /** Quoted single words, numbered after the phrases. */
    exactWordBySurface: Map<string, number>;
    requiredCount: number;
}

function indexQuery(query: ParsedQuery): QueryIndex {
    const termsByStem = new Map<string, number[]>();
    query.terms.forEach((t, i) => {
        for (const stem of new Set([t.stem, ...(t.regularStem !== null ? [t.regularStem] : [])])) termsByStem.set(stem, [...(termsByStem.get(stem) ?? []), i]);
    });
    const phrasesByFirstSurface = new Map<string, number[]>();
    query.phrases.forEach((p, i) => phrasesByFirstSurface.set(p.surfaces[0], [...(phrasesByFirstSurface.get(p.surfaces[0]) ?? []), i]));
    const exactWordBySurface = new Map(query.exactWords.map((w, i) => [w, query.phrases.length + i] as const));
    return { termsByStem, phrasesByFirstSurface, exactWordBySurface, requiredCount: query.phrases.length + query.exactWords.length };
}

export interface RankOptions {
    /** Hits returned at most; the rest are counted. */
    limit: number;
    /** Skip sources that hold no needle (default). `false` tokenises every source: the test that skipping never changes a result. */
    skipUnmatchable?: boolean;
}

/** Rank `docs` against `query`; at most `limit` hits, the rest counted. */
export function rankDocuments(docs: readonly SearchDocument[], query: ParsedQuery, analyzer: Analyzer, options: RankOptions): RankedSearch {
    const wordsBefore = analyzer.wordsSegmented;
    const stemsBefore = analyzer.stemsComputed;
    const index = indexQuery(query);
    const lengthSum = new Map<SearchSourceKind, number>();
    const lengthCount = new Map<SearchSourceKind, number>();
    const matched: DocMatch[] = [];
    let sourcesRead = 0;

    const needles = query.empty ? [] : candidateNeedles(query, analyzer);
    let sourcesTokenised = 0;
    docs.forEach((doc, order) => {
        const sources: SourceMatch[] = [];
        for (const source of doc.sources) {
            if (source.text === '') continue;
            sourcesRead++;
            const length = countWords(source.text);
            lengthSum.set(source.kind, (lengthSum.get(source.kind) ?? 0) + length);
            lengthCount.set(source.kind, (lengthCount.get(source.kind) ?? 0) + 1);
            if (query.empty) continue;
            if (options.skipUnmatchable !== false) {
                const folded = foldText(source.text);
                if (!needles.some((n) => folded.includes(n))) continue;
            }
            sourcesTokenised++;
            const tokens = analyzer.tokenise(source.text, NAME_LIKE.has(source.kind) ? 'name' : 'prose');
            const m = matchSource(source, length, tokens, query, index);
            if (m) sources.push(m);
        }
        if (sources.length > 0) matched.push({ doc, order, sources });
    });

    const work: SearchWork = { sourcesRead, sourcesTokenised, wordsSegmented: analyzer.wordsSegmented - wordsBefore, stemsComputed: analyzer.stemsComputed - stemsBefore };
    const n = docs.length;
    const avg = (kind: SearchSourceKind) => {
        const count = lengthCount.get(kind) ?? 0;
        return count === 0 ? 1 : Math.max(1, (lengthSum.get(kind) ?? 0) / count);
    };

    // A document must hold every required term, and something.
    const qualifying = matched.filter((d) => {
        for (let r = 0; r < index.requiredCount; r++) if (!d.sources.some((s) => s.requiredCounts.has(r))) return false;
        return index.requiredCount > 0 || d.sources.some((s) => s.termWeights.size > 0);
    });

    // Document frequencies over every document holding the term (all of them are in `matched`).
    const dfTerm = query.terms.map((_, t) => matched.filter((d) => d.sources.some((s) => s.termWeights.has(t))).length);
    const requiredDf = Array.from({ length: index.requiredCount }, (_, r) => matched.filter((d) => d.sources.some((s) => s.requiredCounts.has(r))).length);

    const norm = (s: SourceMatch) => {
        const b = SOURCE_LENGTH_NORMALISATION[s.source.kind];
        return SOURCE_WEIGHTS[s.source.kind] / (1 - b + (b * s.length) / avg(s.source.kind));
    };
    const scored = qualifying.map((d) => {
        let score = 0;
        const contribution = new Map<SourceMatch, number>();
        query.terms.forEach((_, t) => {
            let tf = 0;
            for (const s of d.sources) {
                const w = s.termWeights.get(t);
                if (w === undefined) continue;
                const part = w * norm(s);
                tf += part;
                contribution.set(s, (contribution.get(s) ?? 0) + part * idf(n, dfTerm[t]));
            }
            if (tf > 0) score += idf(n, dfTerm[t]) * (tf / (BM25_K1 + tf));
        });
        for (let r = 0; r < index.requiredCount; r++) {
            let pf = 0;
            for (const s of d.sources) {
                const c = s.requiredCounts.get(r);
                if (c === undefined) continue;
                const part = c * norm(s);
                pf += part;
                contribution.set(s, (contribution.get(s) ?? 0) + PHRASE_BOOST * part * idf(n, requiredDf[r]));
            }
            if (pf > 0) score += PHRASE_BOOST * idf(n, requiredDf[r]) * (pf / (BM25_K1 + pf));
        }
        return { d, score, contribution };
    });
    scored.sort((a, b) => b.score - a.score || compare(a.d.doc.name, b.d.doc.name) || compare(a.d.doc.elementId ?? a.d.doc.sceneId ?? '', b.d.doc.elementId ?? b.d.doc.sceneId ?? '') || a.d.order - b.d.order);

    const hits = scored.slice(0, options.limit).map(({ d, contribution }): SearchHitView => {
        // Each source's place read once, not searched for inside the comparator (#48 item 5).
        const place = new Map(d.sources.map((src, i) => [src, i] as const));
        const best = [...d.sources].sort((a, b) => (contribution.get(b) ?? 0) - (contribution.get(a) ?? 0) || place.get(a)! - place.get(b)!);
        return {
            kind: d.doc.kind,
            elementId: d.doc.elementId,
            sceneId: d.doc.sceneId ?? null,
            chapterTitle: d.doc.chapterTitle ?? null,
            elementKind: d.doc.elementKind,
            name: d.doc.name,
            customLabel: d.doc.customLabel,
            matches: best.slice(0, SEARCH_MATCHES_PER_RESULT).map(matchView),
            matchedSourceCount: d.sources.length,
        };
    });
    return { hits, totalHits: scored.length, truncated: scored.length > hits.length, work };
}

/** The characters a stem's words always begin with: all but its last two (at least one). */
export function stemNeedle(stem: string): string {
    return stem.slice(0, Math.max(1, stem.length - 2));
}

/**
 * What a source must contain (folded) to hold any match of the query: one
 * needle per word (its stem's needle and its irregular forms), per phrase
 * (its first word) and per quoted word (the word).
 */
export function candidateNeedles(query: ParsedQuery, analyzer: Pick<Analyzer, 'language'>): string[] {
    const out = new Set<string>();
    for (const t of query.terms) {
        if (analyzer.language === 'en') {
            for (const stem of t.regularStem !== null ? [t.stem, t.regularStem] : [t.stem]) {
                out.add(stemNeedle(stem));
                for (const form of IRREGULAR_SURFACES_BY_STEM.get(stem) ?? []) out.add(form);
            }
        } else {
            out.add(t.surface);
        }
    }
    for (const p of query.phrases) out.add(p.surfaces[0]);
    for (const w of query.exactWords) out.add(w);
    return [...out].filter((n) => n !== '');
}

function compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function matchView(m: SourceMatch): SearchMatchView {
    return {
        source: m.source.kind,
        fieldKey: m.source.fieldKey ?? null,
        fieldLabel: m.source.fieldLabel ?? null,
        otherElementName: m.source.otherElementName ?? null,
        snippet: snippetOf(m.source.text, m.spans),
    };
}

/** Overlapping or touching spans merged, in order. */
export function mergeSpans(spans: readonly Span[]): Span[] {
    const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
    const out: Span[] = [];
    for (const s of sorted) {
        const last = out[out.length - 1];
        if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
        else out.push({ ...s });
    }
    return out;
}

const SPACE = /\s/;

/** A plain-text snippet around the first match, cut at spaces, with its highlights. */
export function snippetOf(text: string, spans: readonly Span[]): SearchSnippet {
    const merged = mergeSpans(spans);
    if (text.length <= SNIPPET_MAX_CHARS || merged.length === 0) {
        const end = Math.min(text.length, SNIPPET_MAX_CHARS);
        const cutAfter = end < text.length;
        return { text: text.slice(0, end), start: 0, cutBefore: false, cutAfter, highlights: highlightsIn(merged, 0, end) };
    }
    const anchor = merged[0];
    let start = Math.max(0, anchor.start - SNIPPET_LEAD_CHARS);
    if (start > 0) {
        // Begin after a space, never inside a word (and never past the match).
        let i = start;
        while (i < anchor.start && !SPACE.test(text[i - 1] ?? ' ')) i++;
        start = i;
    }
    let end = Math.min(text.length, Math.max(start + SNIPPET_MAX_CHARS, anchor.end));
    if (end < text.length) {
        // End before a space, never inside a word (and never before the match ends).
        let j = end;
        while (j > anchor.end && !SPACE.test(text[j] ?? ' ')) j--;
        end = j;
    }
    const slice = text.slice(start, end);
    const lead = slice.length - slice.trimStart().length;
    const trimmed = slice.trim();
    const from = start + lead;
    return { text: trimmed, start: from, cutBefore: from > 0, cutAfter: from + trimmed.length < text.length, highlights: highlightsIn(merged, from, from + trimmed.length) };
}

function highlightsIn(spans: readonly Span[], from: number, to: number): SearchHighlight[] {
    return spans.filter((s) => s.start >= from && s.end <= to).map((s) => ({ start: s.start - from, end: s.end - from }));
}
