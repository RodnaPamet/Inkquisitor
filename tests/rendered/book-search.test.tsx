/**
 * Word search on the book board (Phase 3.4): the query goes in a POST body,
 * results link to their elements, snippets are React text with `<mark>`
 * highlights (never HTML), a refusal is worded from its reason, and the box
 * and its results pass axe.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { BookSearch, HighlightedSnippet, SEARCH_DEBOUNCE_MS } from '@/components/search/BookSearch';
import type { BookSearchView } from '@/lib/search/vocabulary';
import { mockFetch, SLUG } from '../helpers/bible-ui';

const BOOK_ID = 'book_1';
const URL_ = `/api/w/${SLUG}/books/${BOOK_ID}/search`;

const RESULT: BookSearchView = {
    emptyQuery: false,
    hits: [
        {
            kind: 'element',
            elementId: 'el_1',
            elementKind: 'CHARACTER',
            name: 'Ilse',
            customLabel: null,
            matchedSourceCount: 4,
            matches: [
                {
                    source: 'summary',
                    fieldKey: null,
                    fieldLabel: null,
                    otherElementName: null,
                    snippet: { text: 'She ran <b>to</b> the light, running.', start: 0, cutBefore: false, cutAfter: true, highlights: [{ start: 4, end: 7 }, { start: 29, end: 36 }] },
                },
                { source: 'field', fieldKey: 'want', fieldLabel: 'Want', otherElementName: null, snippet: { text: 'to run', start: 0, cutBefore: false, cutAfter: false, highlights: [{ start: 3, end: 6 }] } },
                { source: 'relationNote', fieldKey: null, fieldLabel: null, otherElementName: 'Wenna', snippet: { text: 'runs with her', start: 0, cutBefore: false, cutAfter: false, highlights: [{ start: 0, end: 4 }] } },
            ],
        },
        { kind: 'book', elementId: null, elementKind: null, name: 'The Salt Roads', customLabel: null, matchedSourceCount: 1, matches: [{ source: 'logline', fieldKey: null, fieldLabel: null, otherElementName: null, snippet: { text: 'A run across a drowned country.', start: 0, cutBefore: false, cutAfter: false, highlights: [{ start: 2, end: 5 }] } }] },
    ],
    totalHits: 2,
    truncated: false,
    coverage: { elements: 2, searchedElements: 2, complete: true, cut: null },
    language: 'en',
    analyzerVersion: 'test',
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

async function typeAndWait(text: string) {
    fireEvent.change(screen.getByLabelText('Search this book'), { target: { value: text } });
    await act(async () => {
        jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
}

it('searches as the author types, the query in a POST body, never the URL', async () => {
    const { requests } = mockFetch({ [`POST ${URL_}`]: { json: RESULT } });
    render(<BookSearch workspaceSlug={SLUG} bookId={BOOK_ID} kindLabels={{ CHARACTER: 'Character' }} />);
    await typeAndWait('run');
    await waitFor(() => expect(screen.getByTestId('book-search-status')).toHaveTextContent('2 results'));
    expect(requests).toEqual([{ method: 'POST', url: URL_, body: { q: 'run' } }]);
    expect(requests[0].url).not.toContain('run');
});

it('lists results with links, source labels and highlighted snippets as text', async () => {
    mockFetch({ [`POST ${URL_}`]: { json: RESULT } });
    const { container } = render(<BookSearch workspaceSlug={SLUG} bookId={BOOK_ID} kindLabels={{ CHARACTER: 'Character' }} />);
    await typeAndWait('run');
    const list = await screen.findByRole('list', { name: 'Search results' });
    const [ilse, book] = within(list).getAllByTestId('book-search-hit');
    expect(within(ilse).getByRole('link', { name: 'Ilse' })).toHaveAttribute('href', `/w/${SLUG}/books/${BOOK_ID}/elements/el_1`);
    expect(ilse).toHaveTextContent('Character');
    expect(ilse).toHaveTextContent('Want');
    expect(ilse).toHaveTextContent('Note on the link to Wenna');
    expect(ilse).toHaveTextContent('1 more match in this entry');
    expect(book).toHaveTextContent('The Salt Roads (this book)');
    expect(within(book).queryByRole('link')).toBeNull();
    const marks = Array.from(ilse.querySelectorAll('mark')).map((m) => m.textContent);
    expect(marks).toEqual(['ran', 'running', 'run', 'runs']);
    // Snippet text that looks like markup stays text: no element is made of it.
    expect(ilse.querySelector('b')).toBeNull();
    expect(ilse).toHaveTextContent('She ran <b>to</b> the light, running. …');
    jest.useRealTimers();
    expect(await axe(container)).toHaveNoViolations();
});

it('searches at once on Enter', async () => {
    const { requests } = mockFetch({ [`POST ${URL_}`]: { json: RESULT } });
    render(<BookSearch workspaceSlug={SLUG} bookId={BOOK_ID} kindLabels={{}} />);
    const input = screen.getByLabelText('Search this book');
    fireEvent.change(input, { target: { value: 'lamp' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
        jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    // The pending debounce was dropped: one request, not two.
    expect(requests).toHaveLength(1);
});

it('says when nothing matches, and words a refusal from its reason', async () => {
    let answer: { status?: number; json: unknown } = { json: { ...RESULT, hits: [], totalHits: 0 } };
    mockFetch({ [`POST ${URL_}`]: () => answer });
    render(<BookSearch workspaceSlug={SLUG} bookId={BOOK_ID} kindLabels={{}} />);
    await typeAndWait('zebra');
    await waitFor(() => expect(screen.getByTestId('book-search-status')).toHaveTextContent('Nothing in this book matches.'));
    answer = { status: 400, json: { error: { code: 'VALIDATION', message: 'The search has too many words.', details: { reason: 'QUERY_TOO_MANY_TERMS' } } } };
    await typeAndWait('a b c d e f g h i j k l m');
    await waitFor(() => expect(screen.getByTestId('book-search-status')).toHaveTextContent('That search has too many words. Use twelve or fewer.'));
});

it('says when the book was only partly searched, and when results were cut', async () => {
    mockFetch({ [`POST ${URL_}`]: { json: { ...RESULT, truncated: true, totalHits: 80, coverage: { elements: 2400, searchedElements: 2000, complete: false, cut: 'ELEMENTS_CAP' } } } });
    render(<BookSearch workspaceSlug={SLUG} bookId={BOOK_ID} kindLabels={{}} />);
    await typeAndWait('run');
    await waitFor(() => expect(screen.getByTestId('book-search-partial')).toHaveTextContent('Only the first 2000 of 2400 entries, by name, were searched.'));
    expect(screen.getByText('Showing the best 2 of 80 results. Add a word to narrow the search.')).toBeInTheDocument();
});

describe('HighlightedSnippet', () => {
    it('marks each range, clamps a range past the text, and ignores an overlapping one', () => {
        const { container } = render(<HighlightedSnippet snippet={{ text: 'abcdef', start: 10, cutBefore: true, cutAfter: false, highlights: [{ start: 4, end: 99 }, { start: 0, end: 2 }, { start: 1, end: 3 }] }} />);
        expect(Array.from(container.querySelectorAll('mark')).map((m) => m.textContent)).toEqual(['ab', 'c', 'ef']);
        expect(container).toHaveTextContent('… abcdef');
    });
});
