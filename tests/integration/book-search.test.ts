/**
 * Word search over real, encrypted data (Phase 3.4, decision D21): the
 * book's text is stored sealed, read and decrypted inside the workspace's
 * context, and matched in memory — by a stemmed variant, through rich text
 * and relation notes — and nothing outside the book is ever found: not
 * another book, not another workspace, not a deleted element, not a deleted
 * book. A READER may search. Nothing is written by a search.
 */
const session: { userId: string | null } = { userId: null };
jest.mock('@/auth', () => ({
    auth: async () => (session.userId ? { user: { id: session.userId, email: 'x@example.test', name: null }, expires: '' } : null),
}));

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { POST } from '@/app/api/w/[workspaceSlug]/books/[bookId]/search/route';
import { createBook, deleteBook } from '@/app-layer/usecases/books';
import { createElement, deleteElement } from '@/app-layer/usecases/bible-elements';
import { addRelation } from '@/app-layer/usecases/bible-relations';
import { searchBook } from '@/app-layer/usecases/book-search';
import type { BookSearchView } from '@/lib/search/vocabulary';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const names = (r: BookSearchView) => r.hits.map((h) => h.name);

async function seed() {
    const owner = await createAccount({ workspaceName: 'Search' });
    const ctx = workspaceCtx(owner);
    const book = await createBook(ctx, { title: 'The Wennaway Light', logline: 'A keeper alone with the lamp through a drowned winter.' });
    const ilse = await createElement(ctx, book.id, {
        kind: 'CHARACTER',
        name: 'Ilse Marrow',
        summary: 'The last keeper of the Wennaway light.',
        fields: [
            { key: 'want', value: 'To keep the lamp burning until the relief boat comes.' },
            { key: 'wound', value: '<p>Her brother drowned at the end</p><p>Start of every winter she rows out to the reef.</p>' },
            { key: 'defining_traits', value: ['stubborn', 'watchful'] },
            { key: 'prominence', value: 'carries_book' },
        ],
    });
    const wenna = await createElement(ctx, book.id, { kind: 'SETTING', name: 'Wennaway Rock', summary: 'A tidal island, half drowned at spring tides.' });
    const hope = await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Tomas', summary: 'He names his boat Hope and keeps hoping.' });
    await addRelation(ctx, book.id, { fromElementId: ilse.id, toElementId: wenna.id, type: 'related_to', note: 'She rowed across in the storms of her first year.' });
    // Another book in the same workspace, holding words the first never does.
    const other = await createBook(ctx, { title: 'Saltmarsh', logline: 'Smugglers and lanterns.' });
    await createElement(ctx, other.id, { kind: 'CHARACTER', name: 'Jory Smuggler', summary: 'He smuggles brandy past the lighthouse.' });
    return { owner, ctx, book, ilse, wenna, hope, other };
}

it('stores the book sealed, and finds an element by a stemmed variant of a word in it', async () => {
    const { ctx, book, ilse } = await seed();
    // The text is encrypted at rest: the search reads it only through the workspace's context.
    const stored = await prisma.$queryRaw<Array<{ summary: string }>>`SELECT summary FROM "BibleElement" WHERE id = ${ilse.id}`;
    expect(stored[0].summary.startsWith('v2:')).toBe(true);
    const fields = await prisma.$queryRaw<Array<{ value: string }>>`SELECT value FROM "BibleField" WHERE "elementId" = ${ilse.id}`;
    expect(fields.every((f) => f.value.startsWith('v2:'))).toBe(true);

    const r = await searchBook(ctx, book.id, { q: 'burned' });
    expect(names(r)).toEqual(['Ilse Marrow']);
    const match = r.hits[0].matches[0];
    expect(match).toMatchObject({ source: 'field', fieldKey: 'want', fieldLabel: 'Conscious want' });
    expect(match.snippet.highlights.map((h) => match.snippet.text.slice(h.start, h.end))).toEqual(['burning']);
    expect(r.coverage).toEqual({ elements: 3, searchedElements: 3, complete: true, cut: null });
    expect(r.language).toBe('en');
});

it('reads rich text as plain text: block boundaries never fuse words, and no HTML comes back', async () => {
    const { ctx, book } = await seed();
    const r = await searchBook(ctx, book.id, { q: '"end start"' });
    // "end</p><p>Start" is two words in sequence, across the paragraph break.
    expect(names(r)).toEqual(['Ilse Marrow']);
    const snippet = r.hits[0].matches[0].snippet;
    expect(snippet.text).toContain('drowned at the end\nStart of every winter');
    expect(JSON.stringify(r)).not.toMatch(/<\/?p>/);
    expect(names(await searchBook(ctx, book.id, { q: 'endstart' }))).toEqual([]);
});

it('ranks a name above a summary above a field, and searches labels, lists, choices, notes, the title and logline', async () => {
    const { ctx, book } = await seed();
    // The name and the title (both weighted 3) above Ilse, whose summary says it (weighted 1.5).
    const wennaway = names(await searchBook(ctx, book.id, { q: 'Wennaway' }));
    expect(wennaway.slice(0, 2).sort()).toEqual(['The Wennaway Light', 'Wennaway Rock']);
    expect(wennaway[2]).toBe('Ilse Marrow');
    expect(names(await searchBook(ctx, book.id, { q: 'watchful' }))).toEqual(['Ilse Marrow']);
    expect(names(await searchBook(ctx, book.id, { q: 'carries the book' }))).toEqual(['Ilse Marrow']);
    // A relation note belongs to both of its ends.
    const storms = await searchBook(ctx, book.id, { q: 'storm' });
    expect(names(storms).sort()).toEqual(['Ilse Marrow', 'Wennaway Rock']);
    expect(storms.hits.find((h) => h.name === 'Wennaway Rock')?.matches[0]).toMatchObject({ source: 'relationNote', otherElementName: 'Ilse Marrow' });
    const book_ = (await searchBook(ctx, book.id, { q: 'winter' })).hits.find((h) => h.kind === 'book');
    expect(book_).toMatchObject({ elementId: null, name: 'The Wennaway Light' });
    expect(book_?.matches[0].source).toBe('logline');
});

it('prefers the exact-case name for a capitalised word, and finds the word in any case', async () => {
    const { ctx, book } = await seed();
    const r = await searchBook(ctx, book.id, { q: 'Hope' });
    expect(names(r)).toEqual(['Tomas']);
    expect(r.hits[0].matches[0].snippet.highlights).toHaveLength(2); // "Hope" and "hoping"
});

it('never finds a word of another book or another workspace', async () => {
    const { ctx, book, other } = await seed();
    expect(await searchBook(ctx, book.id, { q: 'smuggler brandy lantern' })).toMatchObject({ hits: [], totalHits: 0 });
    // The other book finds its own words: its element's name, and its logline's "Smugglers" by stem.
    expect(names(await searchBook(ctx, other.id, { q: 'smuggler' }))).toEqual(['Jory Smuggler', 'Saltmarsh']);
    expect(names(await searchBook(ctx, other.id, { q: 'keeper lamp' }))).toEqual([]);

    // A stranger's workspace cannot reach the book at all: a 404, before anything is read.
    const stranger = workspaceCtx(await createAccount());
    await expect(searchBook(stranger, book.id, { q: 'keeper' })).rejects.toMatchObject({ status: 404 });
    // Nor can a book id be borrowed into another workspace's context with its own words.
    await createBook(stranger, { title: 'Keeper of nothing' });
    await expect(searchBook(stranger, book.id, { q: 'keeper' })).rejects.toMatchObject({ status: 404 });
});

it('a READER may search', async () => {
    const { owner, book } = await seed();
    const reader = await createBareUser();
    await addMember(owner.workspaceId, reader.id, 'READER');
    const ctx = workspaceCtx({ userId: reader.id, workspaceId: owner.workspaceId, workspaceSlug: owner.workspaceSlug }, 'READER');
    expect(names(await searchBook(ctx, book.id, { q: 'keeper' }))).toContain('Ilse Marrow');
});

it('leaves out a deleted element, and a deleted book is not found', async () => {
    const { ctx, book, ilse } = await seed();
    await deleteElement(ctx, book.id, ilse.id);
    const r = await searchBook(ctx, book.id, { q: 'lamp burning' });
    expect(names(r)).toEqual(['The Wennaway Light']); // the logline's lamp, nothing of Ilse
    expect(r.coverage.elements).toBe(2);
    await deleteBook(ctx, book.id);
    await expect(searchBook(ctx, book.id, { q: 'lamp' })).rejects.toMatchObject({ status: 404 });
});

it('refuses a query past its bounds by name, and answers an empty one without searching', async () => {
    const { ctx, book } = await seed();
    await expect(searchBook(ctx, book.id, { q: 'a b c d e f g h i j k l m' })).rejects.toMatchObject({ status: 400, details: { reason: 'QUERY_TOO_MANY_TERMS' } });
    await expect(searchBook(ctx, book.id, { q: 'x'.repeat(201) })).rejects.toMatchObject({ status: 400, details: { reason: 'QUERY_TOO_LONG' } });
    await expect(searchBook(ctx, book.id, { q: 'x'.repeat(801) })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(searchBook(ctx, book.id, { q: 'lamp', extra: 1 })).rejects.toMatchObject({ name: 'ZodError' });
    expect(await searchBook(ctx, book.id, { q: '  "" ' })).toMatchObject({ emptyQuery: true, hits: [] });
});

it('writes nothing: no row, no audit entry', async () => {
    const { ctx, book } = await seed();
    const count = async () => {
        const [row] = await prisma.$queryRaw<Array<{ audit: bigint; versions: bigint }>>`
            SELECT (SELECT count(*) FROM "AuditLog" WHERE "workspaceId" = ${ctx.workspaceId}) AS audit,
                   (SELECT count(*) FROM "BibleEntryVersion" WHERE "workspaceId" = ${ctx.workspaceId}) AS versions`;
        return row;
    };
    const before = await count();
    await searchBook(ctx, book.id, { q: 'keeper' });
    expect(await count()).toEqual(before);
});

it('answers through the route: POST with a JSON body, the query never in the URL', async () => {
    const { owner, book } = await seed();
    session.userId = owner.userId;
    try {
        const req = new NextRequest(`http://localhost/api/w/${owner.workspaceSlug}/books/${book.id}/search`, {
            method: 'POST',
            body: JSON.stringify({ q: 'keepers' }),
            headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.31' },
        });
        const res = await POST(req, { params: Promise.resolve({ workspaceSlug: owner.workspaceSlug, bookId: book.id }) });
        expect(res.status).toBe(200);
        const body = (await res.json()) as BookSearchView;
        expect(body.hits.map((h) => h.name)).toContain('Ilse Marrow');
        const refused = await POST(
            new NextRequest(`http://localhost/api/w/${owner.workspaceSlug}/books/${book.id}/search`, { method: 'POST', body: JSON.stringify({ q: '"a b" "c d" "e f" "g h" "i j"' }), headers: { 'content-type': 'application/json' } }),
            { params: Promise.resolve({ workspaceSlug: owner.workspaceSlug, bookId: book.id }) },
        );
        expect(refused.status).toBe(400);
        expect(((await refused.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('QUERY_TOO_MANY_PHRASES');
    } finally {
        session.userId = null;
    }
});
