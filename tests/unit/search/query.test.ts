/**
 * The search query parser (Phase 3.4): quotes, stop words, bounds.
 */
import { createAnalyzer } from '@/lib/search/analyse';
import { parseQuery, splitQuoted, type ParsedQuery } from '@/lib/search/query';
import { SEARCH_QUERY_MAX_CHARS } from '@/lib/search/vocabulary';

const en = createAnalyzer('en');
function parsed(q: string): ParsedQuery {
    const r = parseQuery(q, en);
    if (!r.ok) throw new Error(r.reason);
    return r.query;
}

it('unquoted words are terms by stem, a capitalised one also by its exact case', () => {
    const q = parsed('Running Hope');
    expect(q.terms).toEqual([
        { surface: 'running', stem: 'run', exact: 'Running' },
        { surface: 'hope', stem: 'hope', exact: 'Hope' },
    ]);
    expect(parsed('hope').terms).toEqual([{ surface: 'hope', stem: 'hope', exact: null }]);
});

it('a quoted run of words is a phrase of surface forms; a quoted single word is matched as written', () => {
    const q = parsed('lamp "the red door" "Running"');
    expect(q.terms.map((t) => t.surface)).toEqual(['lamp']);
    expect(q.phrases).toEqual([{ surfaces: ['the', 'red', 'door'] }]);
    expect(q.exactWords).toEqual(['running']);
});

it('curly quotes delimit a phrase too', () => {
    expect(parsed('“red door”').phrases).toEqual([{ surfaces: ['red', 'door'] }]);
});

it('an unbalanced quote is ignored: what follows it is ordinary words', () => {
    expect(splitQuoted('lamp "red door')).toEqual([
        { quoted: false, text: 'lamp ' },
        { quoted: false, text: 'red door' },
    ]);
    const q = parsed('lamp "red door');
    expect(q.phrases).toEqual([]);
    expect(q.terms.map((t) => t.surface)).toEqual(['lamp', 'red', 'door']);
});

it('an empty query, empty quotes or only punctuation is empty', () => {
    expect(parsed('').empty).toBe(true);
    expect(parsed('   ').empty).toBe(true);
    expect(parsed('""').empty).toBe(true);
    expect(parsed('— , !').empty).toBe(true);
    expect(parsed('a').empty).toBe(false);
});

it('drops stop words unless the query holds nothing else; a phrase keeps every word', () => {
    expect(parsed('the lamp of the keeper').terms.map((t) => t.surface)).toEqual(['lamp', 'keeper']);
    expect(parsed('the').terms.map((t) => t.surface)).toEqual(['the']);
    expect(parsed('"of the"').phrases).toEqual([{ surfaces: ['of', 'the'] }]);
});

it('counts a repeated word once', () => {
    expect(parsed('lamp lamps lamp').terms.map((t) => t.surface)).toEqual(['lamp', 'lamps']);
});

describe('bounds: refused by name, never cut', () => {
    it('too long', () => {
        expect(parseQuery('a'.repeat(SEARCH_QUERY_MAX_CHARS), en).ok).toBe(true);
        expect(parseQuery('a'.repeat(SEARCH_QUERY_MAX_CHARS + 1), en)).toEqual({ ok: false, reason: 'QUERY_TOO_LONG' });
        expect(parseQuery(`  ${'a'.repeat(SEARCH_QUERY_MAX_CHARS)}  `, en).ok).toBe(true);
    });

    it('too many words, quoted ones counted', () => {
        expect(parseQuery('w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12', en).ok).toBe(true);
        expect(parseQuery('w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 "w12 w13"', en)).toEqual({ ok: false, reason: 'QUERY_TOO_MANY_TERMS' });
    });

    it('too many phrases', () => {
        expect(parseQuery('"a b" "c d" "e f" "g h"', en).ok).toBe(true);
        expect(parseQuery('"a b" "c d" "e f" "g h" "i"', en)).toEqual({ ok: false, reason: 'QUERY_TOO_MANY_PHRASES' });
    });
});

it('another language keeps stop words and stems nothing', () => {
    const r = parseQuery('the running', createAnalyzer('other'));
    expect(r.ok && r.query.terms.map((t) => [t.surface, t.stem])).toEqual([
        ['the', 'the'],
        ['running', 'running'],
    ]);
});
