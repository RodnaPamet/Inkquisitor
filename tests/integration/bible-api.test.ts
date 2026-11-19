/**
 * The bible API end to end, per role (Phase 1.1): the route handler
 * (`requirePermission` → `getWorkspaceCtx`, a database membership check),
 * the usecase and its own permission check, the audit rows.
 *
 * The session is the one seam: `auth()` says who is signed in. Everything
 * below it is real. Signed out (401), a stranger (404) and a READER on every
 * write handler (403) are also covered generically, for every route file, by
 * tests/integration/api-route-authorization.test.ts.
 */
const session: { userId: string | null } = { userId: null };
jest.mock('@/auth', () => ({
    auth: async () => (session.userId ? { user: { id: session.userId, email: 'x@example.test', name: null }, expires: '' } : null),
}));

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import * as books from '@/app/api/w/[workspaceSlug]/books/route';
import * as book from '@/app/api/w/[workspaceSlug]/books/[bookId]/route';
import * as elements from '@/app/api/w/[workspaceSlug]/books/[bookId]/elements/route';
import * as element from '@/app/api/w/[workspaceSlug]/books/[bookId]/elements/[elementId]/route';
import * as fields from '@/app/api/w/[workspaceSlug]/books/[bookId]/elements/[elementId]/fields/route';
import * as versions from '@/app/api/w/[workspaceSlug]/books/[bookId]/elements/[elementId]/versions/route';
import * as version from '@/app/api/w/[workspaceSlug]/books/[bookId]/elements/[elementId]/versions/[versionNumber]/route';
import * as restore from '@/app/api/w/[workspaceSlug]/books/[bookId]/elements/[elementId]/versions/[versionNumber]/restore/route';
import * as relations from '@/app/api/w/[workspaceSlug]/books/[bookId]/relations/route';
import * as relation from '@/app/api/w/[workspaceSlug]/books/[bookId]/relations/[relationId]/route';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { addRelation, removeRelation } from '@/app-layer/usecases/bible-relations';
import { restoreVersion } from '@/app-layer/usecases/bible-versions';
import { ForbiddenError } from '@/lib/errors/types';
import { rawStringMax } from '@/lib/bible/field-values';
import { JSON_BODY_MAX_BYTES } from '@/lib/http/json-body';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';
import { seedBible } from '../helpers/bible';

afterAll(() => prisma.$disconnect());

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

let owner: Awaited<ReturnType<typeof createAccount>>;
let editor: { id: string };
let reader: { id: string };

beforeAll(async () => {
    owner = await createAccount();
    editor = await createBareUser();
    reader = await createBareUser();
    await addMember(owner.workspaceId, editor.id, 'EDITOR');
    await addMember(owner.workspaceId, reader.id, 'READER');
});

async function call(handler: unknown, method: string, params: Record<string, string>, body?: unknown, query = '') {
    const all = { workspaceSlug: owner.workspaceSlug, ...params };
    const req = new NextRequest(`http://localhost/api/w/${all.workspaceSlug}/probe${query}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.40' },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const res = await (handler as Handler)(req, { params: Promise.resolve(all) });
    return { status: res.status, json: (await res.json()) as unknown };
}

/** The value at a dotted path of a response body (`'element.relations.0'`). */
function at(body: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((v, k) => (v === null || v === undefined ? v : (v as Record<string, unknown>)[k]), body);
}
const str = (body: unknown, path: string) => String(at(body, path));
const idsOf = (list: unknown) => (list as Array<{ id: string }>).map((x) => x.id);

const MARK = ['secret', 'tide', Date.now().toString(36)].join('-');

it('an OWNER walks the whole bible through the routes, and the audit trail holds ids and counts only', async () => {
    session.userId = owner.userId;
    const created = await call(books.POST, 'POST', {}, { title: 'Route book', logline: `logline ${MARK}` });
    expect(created.status).toBe(201);
    const bookId = str(created.json, 'book.id');
    expect(idsOf(at((await call(books.GET, 'GET', {})).json, 'books'))).toContain(bookId);

    const char = await call(elements.POST, 'POST', { bookId }, { kind: 'CHARACTER', name: 'Mara', fields: [{ key: 'role', value: `role ${MARK}` }] });
    expect(char.status).toBe(201);
    const elementId = str(char.json, 'element.id');
    const guild = str((await call(elements.POST, 'POST', { bookId }, { kind: 'FACTION', name: 'Guild' })).json, 'element.id');

    const saved = await call(fields.PUT, 'PUT', { bookId, elementId }, { fields: [{ key: 'want', value: `want ${MARK}` }], baseVersion: 1 });
    expect(saved.status).toBe(200);
    expect(at(saved.json, 'element.versionNumber')).toBe(2);
    expect(at((await call(element.PATCH, 'PATCH', { bookId, elementId }, { status: 'SETTLED', baseVersion: 2 })).json, 'element.status')).toBe('SETTLED');

    const rel = await call(relations.POST, 'POST', { bookId }, { fromElementId: elementId, toElementId: guild, type: 'member_of', note: `note ${MARK}` });
    expect(rel.status).toBe(201);
    const fromGuild = await call(element.GET, 'GET', { bookId, elementId: guild });
    expect(at(fromGuild.json, 'element.relations.0')).toMatchObject({ direction: 'incoming', label: 'has member' });

    expect(idsOf(at((await call(elements.GET, 'GET', { bookId }, undefined, '?kind=FACTION')).json, 'elements'))).toEqual([guild]);
    const list = await call(versions.GET, 'GET', { bookId, elementId }, undefined, '?take=2');
    expect((at(list.json, 'versions') as Array<{ versionNumber: number }>).map((v) => v.versionNumber)).toEqual([3, 2]);
    expect(at((await call(version.GET, 'GET', { bookId, elementId, versionNumber: '1' })).json, 'version.snapshot.fields')).toEqual([
        { key: 'role', order: 1, value: `role ${MARK}` },
    ]);
    const restored = await call(restore.POST, 'POST', { bookId, elementId, versionNumber: '1' }, { baseVersion: 3 });
    expect(restored.status).toBe(201);
    expect(at(restored.json, 'restore.version')).toMatchObject({ versionNumber: 4, restoredFromVersion: 1 });

    expect((await call(relation.DELETE, 'DELETE', { bookId, relationId: str(rel.json, 'relation.id') })).status).toBe(200);
    expect((await call(element.DELETE, 'DELETE', { bookId, elementId: guild })).status).toBe(200);
    expect(at((await call(book.PATCH, 'PATCH', { bookId }, { stage: 'DRAFTING' })).json, 'book.stage')).toBe('DRAFTING');
    expect((await call(book.DELETE, 'DELETE', { bookId })).status).toBe(200);
    expect((await call(book.GET, 'GET', { bookId })).status).toBe(404);

    const rows = await prisma.auditLog.findMany({ where: { workspaceId: owner.workspaceId, actorUserId: owner.userId }, select: { action: true, detailsJson: true } });
    const actions = new Set(rows.map((r) => r.action));
    for (const a of [
        'BOOK_CREATED',
        'BOOK_UPDATED',
        'BOOK_DELETED',
        'BIBLE_ELEMENT_CREATED',
        'BIBLE_ELEMENT_UPDATED',
        'BIBLE_ELEMENT_DELETED',
        'BIBLE_FIELDS_UPDATED',
        'BIBLE_RELATION_CREATED',
        'BIBLE_RELATION_DELETED',
        'BIBLE_VERSION_RESTORED',
    ]) {
        expect(actions).toContain(a);
    }
    expect(JSON.stringify(rows)).not.toContain(MARK);
    const deleted = rows.find((r) => r.action === 'BOOK_DELETED')?.detailsJson;
    expect(deleted).toEqual({ elements: 1, relations: 0, versions: 5, restorableUntil: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
});

it('an EDITOR writes the bible', async () => {
    session.userId = editor.id;
    const created = await call(books.POST, 'POST', {}, { title: 'Editor book' });
    expect(created.status).toBe(201);
    expect((await call(elements.POST, 'POST', { bookId: str(created.json, 'book.id') }, { kind: 'THEME', name: 'Home' })).status).toBe(201);
});

describe('a READER', () => {
    let seeded: Awaited<ReturnType<typeof seedBible>>;
    beforeAll(async () => {
        seeded = await seedBible(workspaceCtx(owner), 'reader');
    });

    it('reads every bible route', async () => {
        session.userId = reader.id;
        const p = { bookId: seeded.bookId, elementId: seeded.characterId };
        for (const [h, params] of [
            [books.GET, {}],
            [book.GET, { bookId: seeded.bookId }],
            [elements.GET, { bookId: seeded.bookId }],
            [element.GET, p],
            [versions.GET, p],
            [version.GET, { ...p, versionNumber: '1' }],
        ] as const) {
            expect((await call(h, 'GET', params)).status).toBe(200);
        }
    });

    it('is refused every write at the usecase too (a usecase reached another way still refuses, and audits)', async () => {
        const rctx = { ...workspaceCtx(owner, 'READER'), userId: reader.id };
        const denied = () => prisma.auditLog.count({ where: { workspaceId: owner.workspaceId, action: 'AUTHZ_DENIED', actorUserId: reader.id } });
        const before = await denied();
        const writes = [
            () => createBook(rctx, { title: 'x' }),
            () => createElement(rctx, seeded.bookId, { kind: 'PLOT', name: 'x' }),
            () => updateElementFields(rctx, seeded.bookId, seeded.characterId, { fields: [{ key: 'want', value: 'x' }], baseVersion: 1 }),
            () => addRelation(rctx, seeded.bookId, { fromElementId: seeded.characterId, toElementId: seeded.factionId, type: 'related_to' }),
            () => removeRelation(rctx, seeded.bookId, seeded.relationId),
            () => restoreVersion(rctx, seeded.bookId, seeded.characterId, 1, { baseVersion: 1 }),
        ];
        for (const w of writes) await expect(w()).rejects.toBeInstanceOf(ForbiddenError);
        expect(await denied()).toBe(before + writes.length);
        expect(await prisma.bibleEntryVersion.count({ where: { elementId: seeded.characterId } })).toBe(1);
    });
});

describe('malformed requests', () => {
    let bookId: string;
    beforeAll(async () => {
        bookId = (await createBook(workspaceCtx(owner), { title: 'Bad requests' })).id;
    });

    it('a body that is not JSON is a 400, not a 500', async () => {
        session.userId = owner.userId;
        const res = await call(elements.POST, 'POST', { bookId }, '{not json');
        expect(res.status).toBe(400);
        expect(at(res.json, 'error.details')).toEqual({ reason: 'BODY_NOT_JSON' });
    });

    it('an unknown key, a bad kind query and a bad version number are 400s', async () => {
        session.userId = owner.userId;
        expect((await call(books.POST, 'POST', {}, { title: 'x', colour: 'red' })).status).toBe(400);
        expect((await call(elements.GET, 'GET', { bookId }, undefined, '?kind=DRAGON')).status).toBe(400);
        const el = await createElement(workspaceCtx(owner), bookId, { kind: 'PLOT', name: 'Main' });
        expect((await call(version.GET, 'GET', { bookId, elementId: el.id, versionNumber: 'one' })).status).toBe(400);
        expect((await call(version.GET, 'GET', { bookId, elementId: el.id, versionNumber: '9' })).status).toBe(404);
    });

    it('a version cursor past PostgreSQL\'s integer is a 400, not a 500', async () => {
        session.userId = owner.userId;
        const el = await createElement(workspaceCtx(owner), bookId, { kind: 'PLOT', name: 'Cursor' });
        expect((await call(versions.GET, 'GET', { bookId, elementId: el.id }, undefined, '?before=2147483647')).status).toBe(200);
        expect((await call(versions.GET, 'GET', { bookId, elementId: el.id }, undefined, '?before=2147483648')).status).toBe(400);
        expect((await call(versions.GET, 'GET', { bookId, elementId: el.id }, undefined, '?before=99999999999999999999')).status).toBe(400);
    });

    it('a body past the cap is a 413, and an oversized field value a 400, with nothing written', async () => {
        session.userId = owner.userId;
        const el = await createElement(workspaceCtx(owner), bookId, { kind: 'CHARACTER', name: 'Big' });
        const huge = { fields: [{ key: 'wound', value: 'x'.repeat(JSON_BODY_MAX_BYTES) }] };
        const tooBig = await call(fields.PUT, 'PUT', { bookId, elementId: el.id }, huge);
        expect(tooBig.status).toBe(413);
        expect(at(tooBig.json, 'error.details')).toMatchObject({ reason: 'BODY_TOO_LARGE' });
        const oversizedValue = { fields: [{ key: 'wound', value: 'x'.repeat(rawStringMax() + 1) }], baseVersion: 1 };
        expect((await call(fields.PUT, 'PUT', { bookId, elementId: el.id }, oversizedValue)).status).toBe(400);
        expect(await prisma.bibleEntryVersion.count({ where: { elementId: el.id } })).toBe(1);
    });

    it('a refused field batch names every refusal', async () => {
        session.userId = owner.userId;
        const el = await createElement(workspaceCtx(owner), bookId, { kind: 'MOOD', name: 'Dread' });
        const res = await call(fields.PUT, 'PUT', { bookId, elementId: el.id }, { fields: [{ key: 'intensity', value: 9 }], baseVersion: 1 });
        expect(res.status).toBe(400);
        expect(at(res.json, 'error.details')).toEqual({ reason: 'FIELD_VALUES_REFUSED', fields: [{ key: 'intensity', reason: 'OUT_OF_RANGE' }] });
    });
});
