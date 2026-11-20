/**
 * The query egress check (Phase 2.6, decision D9): a search query or a fetch
 * URL that quotes the book's stored text is refused; a topic, a single name,
 * or another page of a site the bible cites is not.
 */
import { buildBookTextIndex, outgoingTextRefusal, SHINGLE_WORDS, toolUseRefusal } from '@/lib/research/query-egress';

const BOOK = buildBookTextIndex([
    'Wren Ashdown',
    'A royal falconer who keeps the queen’s gyrfalcons in the old stone mews.',
    'Sources: https://en.wikipedia.example/wiki/Falconry — consulted',
]);

describe('outgoingTextRefusal', () => {
    it.each([
        ['a topic in plain words', 'medieval falconry hawk training methods'],
        ['a single name the brief may give', 'Wren falconer'],
        ['common words in common with the book', 'who keeps the hawks in a medieval castle'],
        ['another page of a site the bible cites', 'https://en.wikipedia.example/wiki/Hawking_(hunting)'],
    ])('lets %s leave', (_label, text) => {
        expect(outgoingTextRefusal(text, BOOK)).toBeNull();
    });

    it.each([
        ['a run of the stored text', 'keeps the queen’s gyrfalcons in the old stone mews history'],
        ['the same words with other quotes, case and spacing', 'KEEPS THE QUEEN\'S   GYRFALCONS'],
        ['the stored text inside a URL path', 'https://example.org/search/queens-gyrfalcons-in-the-old-stone-mews'],
        ['the stored text in a URL query, percent-encoded', 'https://example.org/s?q=queen%E2%80%99s%20gyrfalcons%20in%20the%20old'],
    ])('refuses %s', (_label, text) => {
        expect(outgoingTextRefusal(text, BOOK)).toBe('QUOTES_BOOK_TEXT');
    });

    it.each([
        ['spelt in a subdomain', 'https://queens-gyrfalcons-in-the-old-stone-mews.example.org/'],
        ['spelt across subdomain labels', 'https://queens.gyrfalcons.in.the.old.example.org/index.html'],
        ['in a brief URL’s host with an innocent path', 'https://royal-falconer-who-keeps.example.net/about'],
    ])('refuses the stored text %s: a host is sent to the resolver and the site too', (_label, text) => {
        expect(outgoingTextRefusal(text, BOOK)).toBe('QUOTES_BOOK_TEXT');
        expect(toolUseRefusal({ tool: 'web_fetch', input: { url: text } }, BOOK)).toBe('QUOTES_BOOK_TEXT');
    });

    it.each([
        ['a stray malformed escape beside %20-spelt words', 'https://example.org/s?q=queen%E2%80%99s%20gyrfalcons%20in%20the%20old&x=%zz'],
        ['a lone truncated escape in a query', 'queen%27s%20gyrfalcons%20in%20the%20old%E2'],
        ['a double-encoded quotation', 'https://example.org/s?q=queens%2520gyrfalcons%2520in%2520the%2520old'],
    ])('refuses %s: one bad escape does not stop the rest being decoded', (_label, text) => {
        expect(outgoingTextRefusal(text, BOOK)).toBe('QUOTES_BOOK_TEXT');
    });

    it('refuses a secret whatever the book holds (2.1’s egress scanner)', () => {
        expect(outgoingTextRefusal(`falconry ${['AKIA', 'IOSFODNN7EXAMPLE'].join('')}`, BOOK)).toBe('CARRIES_SECRET');
    });

    it('refuses everything when the book was too large to index: it never vouches for text it did not read', () => {
        const huge = buildBookTextIndex(['x'.repeat(4_000_001)]);
        expect(huge.incomplete).toBe(true);
        expect(outgoingTextRefusal('medieval falconry', huge)).toBe('INDEX_INCOMPLETE');
    });

    it(`quotes are runs of ${SHINGLE_WORDS} words with at least two content words`, () => {
        const idx = buildBookTextIndex(['it is in the']);
        expect(outgoingTextRefusal('what it is in the end', idx)).toBeNull();
    });
});

describe('toolUseRefusal (the tripwire)', () => {
    it('judges a search query and a fetch URL; refuses any other tool and an unreadable input', () => {
        expect(toolUseRefusal({ tool: 'web_search', input: { query: 'falconry history' } }, BOOK)).toBeNull();
        expect(toolUseRefusal({ tool: 'web_search', input: { query: 'queen’s gyrfalcons in the old stone mews' } }, BOOK)).toBe('QUOTES_BOOK_TEXT');
        expect(toolUseRefusal({ tool: 'web_fetch', input: { url: 'https://falconry.example.org/manning' } }, BOOK)).toBeNull();
        expect(toolUseRefusal({ tool: 'web_search', input: {} }, BOOK)).toBe('UNREADABLE_TOOL_INPUT');
        expect(toolUseRefusal({ tool: 'code_execution', input: { code: 'x' } }, BOOK)).toBe('TOOL_NOT_PERMITTED');
    });
});
