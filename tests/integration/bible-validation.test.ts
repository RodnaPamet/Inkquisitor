/**
 * What the bible refuses, and what it cleans, on the way in (Phase 1.1).
 *
 *   - field values against their template: unknown keys, wrong types,
 *     choices not offered, scales out of range — all reported at once;
 *   - the CUSTOM label rule, names, slugs (unique per book, derived and
 *     suffixed), by the usecase and again by the database's CHECKs;
 *   - relations: typed by the template, target kinds, self, cross-book,
 *     duplicates (both ways for a type that reads the same both ways);
 *   - SANITISING: markup and script written through every author-text path is
 *     stored stripped (read back raw, decrypted, not just through the view).
 */
import { prisma } from '@/lib/db';
import { createElement, getElement, updateElement, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { addRelation } from '@/app-layer/usecases/bible-relations';
import { getVersion } from '@/app-layer/usecases/bible-versions';
import { createBook, getBook, updateBook } from '@/app-layer/usecases/books';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { ZodError } from 'zod';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let ctx: ReturnType<typeof workspaceCtx>;
let account: Awaited<ReturnType<typeof createAccount>>;
let bookId: string;

beforeAll(async () => {
    account = await createAccount();
    ctx = workspaceCtx(account);
    bookId = (await createBook(ctx, { title: 'Validation book' })).id;
});

async function refusal(p: Promise<unknown>): Promise<{ error: unknown; details: Record<string, unknown> }> {
    try {
        await p;
    } catch (error) {
        return { error, details: ((error as { details?: unknown }).details ?? {}) as Record<string, unknown> };
    }
    throw new Error('expected a refusal');
}

describe('field values', () => {
    it('reports every refused value at once, and writes none of the batch', async () => {
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Batch' });
        const { error, details } = await refusal(
            updateElementFields(ctx, bookId, el.id, {
                fields: [
                    { key: 'want', value: 'good' },
                    { key: 'no_such_field', value: 'x' },
                    { key: 'prominence', value: 'not_an_option' },
                    { key: 'agency', value: 6 },
                    { key: 'defining_traits', value: 'not a list' },
                    { key: 'wound', value: 5 },
                    { key: 'want', value: 'twice' },
                ],
            }),
        );
        expect(error).toBeInstanceOf(ValidationError);
        expect(details.fields).toEqual([
            { key: 'no_such_field', reason: 'UNKNOWN_FIELD' },
            { key: 'prominence', reason: 'NOT_AN_OPTION' },
            { key: 'agency', reason: 'OUT_OF_RANGE' },
            { key: 'defining_traits', reason: 'NOT_A_LIST' },
            { key: 'wound', reason: 'NOT_A_STRING' },
            { key: 'want', reason: 'DUPLICATE_FIELD' },
        ]);
        expect(await prisma.bibleField.count({ where: { elementId: el.id } })).toBe(0);
    });

    it('a key of another kind is unknown here', async () => {
        const place = await createElement(ctx, bookId, { kind: 'SETTING', name: 'Harbour' });
        const { details } = await refusal(updateElementFields(ctx, bookId, place.id, { fields: [{ key: 'want', value: 'x' }] }));
        expect(details.fields).toEqual([{ key: 'want', reason: 'UNKNOWN_FIELD' }]);
    });

    it('accepts every type in its own shape', async () => {
        const el = await createElement(ctx, bookId, {
            kind: 'CHARACTER',
            name: 'Typed',
            fields: [
                { key: 'role', value: 'Lead' },
                { key: 'prominence', value: 'major' },
                { key: 'agency', value: 2 },
                { key: 'defining_traits', value: ['wry', 'loyal'] },
                { key: 'wound', value: '<p>The <em>flood</em></p>' },
            ],
        });
        const values = Object.fromEntries((await getElement(ctx, bookId, el.id)).fields.map((f) => [f.key, f.value]));
        expect(values).toMatchObject({ role: 'Lead', prominence: 'major', agency: 2, defining_traits: ['wry', 'loyal'], wound: '<p>The <em>flood</em></p>' });
    });
});

describe('elements', () => {
    it('a CUSTOM element needs its label; no other kind may carry one', async () => {
        expect((await refusal(createElement(ctx, bookId, { kind: 'CUSTOM', name: 'Thing' }))).details.reason).toBe('CUSTOM_LABEL_REQUIRED');
        expect((await refusal(createElement(ctx, bookId, { kind: 'CUSTOM', name: 'Thing', customLabel: '<b></b>' }))).details.reason).toBe('EMPTY');
        expect((await refusal(createElement(ctx, bookId, { kind: 'PLOT', name: 'Main', customLabel: 'Prophecy' }))).details.reason).toBe(
            'CUSTOM_LABEL_NOT_ALLOWED',
        );
        const custom = await createElement(ctx, bookId, { kind: 'CUSTOM', name: 'The prophecy', customLabel: '  Prophecy  ' });
        expect(custom.customLabel).toBe('Prophecy');
    });

    it('the database holds the custom-label rule too, whoever writes', async () => {
        const base = { workspaceId: account.workspaceId, bookId, name: 'Raw', slug: `raw-${Date.now()}` };
        await expect(prisma.bibleElement.create({ data: { ...base, kind: 'CUSTOM' } })).rejects.toThrow(/BibleElement_customLabel_iff_custom/);
        await expect(prisma.bibleElement.create({ data: { ...base, kind: 'PLOT', customLabel: 'x' } })).rejects.toThrow(/BibleElement_customLabel_iff_custom/);
        await expect(prisma.bibleElement.create({ data: { ...base, kind: 'PLOT', name: ' padded ' } })).rejects.toThrow(/BibleElement_name_bounded/);
        await expect(prisma.bibleElement.create({ data: { ...base, kind: 'PLOT', slug: 'Not A Slug' } })).rejects.toThrow(/BibleElement_slug_shape/);
    });

    it('names are trimmed, bounded, and refused when nothing is left after sanitising', async () => {
        const el = await createElement(ctx, bookId, { kind: 'THEME', name: '   Grief   ' });
        expect(el.name).toBe('Grief');
        expect((await refusal(createElement(ctx, bookId, { kind: 'THEME', name: '<i> </i>' }))).details.reason).toBe('EMPTY');
        expect((await refusal(createElement(ctx, bookId, { kind: 'THEME', name: 'x'.repeat(121) }))).details.reason).toBe('TOO_LONG');
        await expect(createElement(ctx, bookId, { kind: 'THEME', name: '' })).rejects.toBeInstanceOf(ZodError);
        await expect(createElement(ctx, bookId, { kind: 'DRAGON', name: 'x' })).rejects.toBeInstanceOf(ZodError);
    });

    it('slugs are unique per book: derived ones take a suffix, a given one that is taken is a 409', async () => {
        const first = await createElement(ctx, bookId, { kind: 'SETTING', name: 'The Quay' });
        const second = await createElement(ctx, bookId, { kind: 'SETTING', name: 'the quay' });
        expect([first.slug, second.slug]).toEqual(['the-quay', 'the-quay-2']);
        const { error, details } = await refusal(createElement(ctx, bookId, { kind: 'SETTING', name: 'Other', slug: 'the-quay' }));
        expect(error).toBeInstanceOf(ConflictError);
        expect(details.reason).toBe('SLUG_TAKEN');
        expect((await refusal(updateElement(ctx, bookId, second.id, { slug: 'the-quay' }))).details.reason).toBe('SLUG_TAKEN');
        // Another book may use the same slug.
        const otherBook = await createBook(ctx, { title: 'Other book' });
        expect((await createElement(ctx, otherBook.id, { kind: 'SETTING', name: 'The Quay' })).slug).toBe('the-quay');
    });

    it('an element of a book that does not exist, or of no book of this workspace, is a 404', async () => {
        await expect(createElement(ctx, 'no-such-book', { kind: 'PLOT', name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    });
});

describe('relations', () => {
    let character: string;
    let faction: string;
    let place: string;
    let ally: string;

    beforeAll(async () => {
        character = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Relator' })).id;
        ally = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Ally' })).id;
        faction = (await createElement(ctx, bookId, { kind: 'FACTION', name: 'Guild' })).id;
        place = (await createElement(ctx, bookId, { kind: 'SETTING', name: 'Relation harbour' })).id;
    });

    it('are stored once and read from both ends, under the inverse label at the far end', async () => {
        const rel = await addRelation(ctx, bookId, { fromElementId: character, toElementId: faction, type: 'member_of' });
        expect([rel.label, rel.inverseLabel]).toEqual(['member of', 'has member']);
        const fromEnd = (await getElement(ctx, bookId, character)).relations.find((r) => r.id === rel.id);
        const toEnd = (await getElement(ctx, bookId, faction)).relations.find((r) => r.id === rel.id);
        expect(fromEnd).toMatchObject({ direction: 'outgoing', label: 'member of', other: { id: faction } });
        expect(toEnd).toMatchObject({ direction: 'incoming', label: 'has member', other: { id: character } });
        expect(await prisma.bibleRelation.count({ where: { OR: [{ fromElementId: character }, { toElementId: character }], type: 'member_of' } })).toBe(1);
    });

    it('refuse a type whose target kinds do not include the target, and a type the from kind does not declare', async () => {
        expect((await refusal(addRelation(ctx, bookId, { fromElementId: character, toElementId: place, type: 'member_of' }))).details.reason).toBe(
            'RELATION_TYPE_NOT_ALLOWED',
        );
        // member_of is declared on CHARACTER: a FACTION cannot start it.
        expect((await refusal(addRelation(ctx, bookId, { fromElementId: faction, toElementId: character, type: 'member_of' }))).details.reason).toBe(
            'RELATION_TYPE_NOT_ALLOWED',
        );
        expect((await refusal(addRelation(ctx, bookId, { fromElementId: character, toElementId: faction, type: 'invented_type' }))).details.reason).toBe(
            'RELATION_TYPE_NOT_ALLOWED',
        );
    });

    it('refuse an element related to itself, and two books', async () => {
        expect((await refusal(addRelation(ctx, bookId, { fromElementId: character, toElementId: character, type: 'related_to' }))).details.reason).toBe(
            'SELF_RELATION',
        );
        const otherBook = await createBook(ctx, { title: 'Far book' });
        const far = await createElement(ctx, otherBook.id, { kind: 'FACTION', name: 'Far guild' });
        expect((await refusal(addRelation(ctx, bookId, { fromElementId: character, toElementId: far.id, type: 'member_of' }))).details.reason).toBe(
            'CROSS_BOOK',
        );
        await expect(addRelation(ctx, bookId, { fromElementId: character, toElementId: 'no-such-element', type: 'related_to' })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('refuse a duplicate, and for a type that reads the same both ways, its reverse', async () => {
        await addRelation(ctx, bookId, { fromElementId: character, toElementId: ally, type: 'sibling_of' });
        expect((await refusal(addRelation(ctx, bookId, { fromElementId: character, toElementId: ally, type: 'sibling_of' }))).details.reason).toBe(
            'RELATION_EXISTS',
        );
        expect((await refusal(addRelation(ctx, bookId, { fromElementId: ally, toElementId: character, type: 'sibling_of' }))).details.reason).toBe(
            'RELATION_EXISTS',
        );
        // A directed type may run both ways: each is a different fact.
        await addRelation(ctx, bookId, { fromElementId: character, toElementId: ally, type: 'mentor_of' });
        await expect(addRelation(ctx, bookId, { fromElementId: ally, toElementId: character, type: 'mentor_of' })).resolves.toMatchObject({ type: 'mentor_of' });
    });

    it('the built-in related_to links any two kinds', async () => {
        await expect(addRelation(ctx, bookId, { fromElementId: place, toElementId: character, type: 'related_to' })).resolves.toMatchObject({
            label: 'related to',
            inverseLabel: 'related to',
        });
    });
});

describe('sanitising on every author-text write path', () => {
    const XSS = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const clean = (v: unknown) => expect(JSON.stringify(v)).not.toMatch(/<script|onerror|alert\(/);

    it('book title, logline, genre and audience', async () => {
        const book = await createBook(ctx, { title: `Tide ${XSS}`, logline: `A ${XSS} story`, genre: `Saga${XSS}`, audience: `<b>Adult</b>` });
        expect(book.title).toBe('Tide');
        expect(book.audience).toBe('Adult');
        clean(await getBook(ctx, book.id));
        const updated = await updateBook(ctx, book.id, { logline: '&lt;script&gt;alert(3)&lt;/script&gt;Line' });
        clean(updated);
        expect(updated.logline).toBe('Line');
    });

    it('element name, summary, custom label, every field type, change summary and relation note — and the version snapshot', async () => {
        const el = await createElement(ctx, bookId, {
            kind: 'CUSTOM',
            name: `Relic ${XSS}`,
            customLabel: `Artefact${XSS}`,
            summary: `First line ${XSS}\n\nSecond`,
            fields: [
                { key: 'purpose', value: `Purpose ${XSS}` },
                { key: 'key_details', value: [`detail ${XSS}`, XSS] },
                { key: 'connections', value: `<p onclick="x()">Links</p>${XSS}<a href="javascript:alert(4)">l</a>` },
            ],
            changeSummary: `Change ${XSS}`,
        });
        const view = await getElement(ctx, bookId, el.id);
        clean(view);
        expect(view.name).toBe('Relic');
        expect(view.summary).toBe('First line\n\nSecond');
        expect(view.fields.find((f) => f.key === 'key_details')?.value).toEqual(['detail']);
        expect(String(view.fields.find((f) => f.key === 'connections')?.value)).toContain('<p>Links</p>');
        const v1 = await getVersion(ctx, bookId, el.id, 1);
        clean(v1);
        expect(v1.changeSummary).toBe('Change');

        const target = await createElement(ctx, bookId, { kind: 'CUSTOM', name: 'Other relic', customLabel: 'Artefact' });
        const rel = await addRelation(ctx, bookId, { fromElementId: el.id, toElementId: target.id, type: 'related_to', note: `Note ${XSS}` });
        expect(rel.note).toBe('Note');
    });

    it('control characters, raw or as entities, never reach a text column (a NUL was a 500)', async () => {
        const book = await createBook(ctx, {
            title: 'Ti\u0000de&#0;',
            logline: 'Line\u0000 one&#0;',
            genre: 'Sa&#0;ga\u0001',
            audience: 'Ad\u0000ult',
        });
        expect(book).toMatchObject({ title: 'Tide', logline: 'Line one', genre: 'Saga', audience: 'Adult' });
        const updated = await updateBook(ctx, book.id, { title: '&#0;Renamed\u0000', genre: '\u0000', audience: '&#0;' });
        expect(updated).toMatchObject({ title: 'Renamed', genre: null, audience: null });

        const el = await createElement(ctx, bookId, {
            kind: 'CUSTOM',
            name: 'Re&#0;lic\u0000',
            customLabel: 'Arte\u0000fact&#0;',
            summary: 'Sum\u0000mary',
            fields: [
                { key: 'purpose', value: 'Pur&#0;pose' },
                { key: 'key_details', value: ['de\u0000tail'] },
            ],
        });
        expect(el).toMatchObject({ name: 'Relic', customLabel: 'Artefact', summary: 'Summary' });
        const values = Object.fromEntries(el.fields.map((f) => [f.key, f.value]));
        expect(values).toMatchObject({ purpose: 'Purpose', key_details: ['detail'] });
        const renamed = await updateElement(ctx, bookId, el.id, { name: '\u0000Relic two&#0;' });
        expect(renamed.name).toBe('Relic two');
        const raw = await prisma.bibleElement.findUniqueOrThrow({ where: { id: el.id }, select: { name: true, customLabel: true } });
        expect(raw).toEqual({ name: 'Relic two', customLabel: 'Artefact' });
    });
});
