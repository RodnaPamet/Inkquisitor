/**
 * Deleting a book (Phase 1.H, item 7): soft, the OWNER's alone, restorable
 * for 30 days, then purged by the daily job.
 *
 *   - `books.delete` is OWNER-only: an EDITOR's delete is a 403 with an
 *     AUTHZ_DENIED row, and the book stays;
 *   - a deleted book leaves every list, and EVERY route under it answers 404
 *     (called, not read: each handler under `books/[bookId]/**`, with the
 *     book's real element, relation and version);
 *   - the OWNER lists it and restores it whole within 30 days; past the
 *     window it is a 404;
 *   - the purge deletes only books deleted more than 30 days ago, with their
 *     elements, fields, relations, version history and vectors, writes a
 *     BOOK_PURGED audit row in the book's workspace as the system, skips a
 *     book restored since it was found, and runs as the `book-purge` job.
 */
const session: { userId: string | null } = { userId: null };
jest.mock('@/auth', () => ({
    auth: async () => (session.userId ? { user: { id: session.userId, email: 'x@example.test', name: null }, expires: '' } : null),
}));

import * as path from 'node:path';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { executorRegistry } from '@/app-layer/jobs/executor-registry';
import { purgeDeletedBooks } from '@/app-layer/usecases/book-purge';
import { getBookBoard, getElement } from '@/app-layer/usecases/bible-elements';
import { deleteBook, getBook, listBooks, listDeletedBooks, restoreBook } from '@/app-layer/usecases/books';
import { ForbiddenError, NotFoundError } from '@/lib/errors/types';
import { exportsOf, readRoute, routeHandlerFiles, urlAndParamsFor } from '../helpers/api-routes';
import { seedInterview } from '../helpers/interview';
import { seedBible } from '../helpers/bible';
import { REPO_ROOT } from '../helpers/repo-files';
import { seedVectors } from '../helpers/vectors';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
let owner: Awaited<ReturnType<typeof createAccount>>;
let ctx: ReturnType<typeof workspaceCtx>;
let editorCtx: ReturnType<typeof workspaceCtx>;

beforeAll(async () => {
    owner = await createAccount();
    ctx = workspaceCtx(owner);
    const editor = await createBareUser();
    await addMember(owner.workspaceId, editor.id, 'EDITOR');
    editorCtx = { ...workspaceCtx(owner, 'EDITOR'), userId: editor.id };
});

/** Move a book's deletion into the past, as the superuser (the product never back-dates). */
const deletedDaysAgo = (bookId: string, days: number) => prisma.book.update({ where: { id: bookId }, data: { deletedAt: new Date(Date.now() - days * DAY) } });
const contentsOf = async (bookId: string) => ({
    elements: await prisma.bibleElement.count({ where: { bookId } }),
    fields: await prisma.bibleField.count({ where: { element: { bookId } } }),
    relations: await prisma.bibleRelation.count({ where: { bookId } }),
    versions: await prisma.bibleEntryVersion.count({ where: { bookId } }),
    vectors: await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "VectorEmbedding" WHERE "bookId" = ${bookId}`.then((r) => r[0].n),
});

describe('who may delete', () => {
    it('an EDITOR may not: 403, an AUTHZ_DENIED row, and the book stays', async () => {
        const { bookId } = await seedBible(ctx, 'editor-try');
        const denied = () => prisma.auditLog.count({ where: { workspaceId: owner.workspaceId, action: 'AUTHZ_DENIED', actorUserId: editorCtx.userId } });
        const before = await denied();
        await expect(deleteBook(editorCtx, bookId)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(restoreBook(editorCtx, bookId)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(listDeletedBooks(editorCtx)).rejects.toBeInstanceOf(ForbiddenError);
        expect(await denied()).toBe(before + 3);
        await expect(getBook(ctx, bookId)).resolves.toMatchObject({ id: bookId });
    });
});

describe('a deleted book', () => {
    it('leaves the lists, keeps every row, and is audited with its contents', async () => {
        const seeded = await seedBible(ctx, 'soft');
        const before = await contentsOf(seeded.bookId);
        const deleted = await deleteBook(ctx, seeded.bookId);
        expect(new Date(deleted.restorableUntil).getTime() - new Date(deleted.deletedAt).getTime()).toBe(30 * DAY);
        expect((await listBooks(ctx)).books.map((b) => b.id)).not.toContain(seeded.bookId);
        await expect(getBook(ctx, seeded.bookId)).rejects.toBeInstanceOf(NotFoundError);
        await expect(getElement(ctx, seeded.bookId, seeded.characterId)).rejects.toBeInstanceOf(NotFoundError);
        await expect(getBookBoard(ctx, seeded.bookId)).rejects.toBeInstanceOf(NotFoundError);
        await expect(deleteBook(ctx, seeded.bookId)).rejects.toBeInstanceOf(NotFoundError);
        expect(await contentsOf(seeded.bookId)).toEqual(before);
        const row = await prisma.auditLog.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, action: 'BOOK_DELETED', entityId: seeded.bookId } });
        expect(row.detailsJson).toMatchObject({ elements: 2, relations: 1, versions: 2, restorableUntil: deleted.restorableUntil });
    });

    it('answers 404 on every route under it, for its OWNER', async () => {
        const seeded = await seedBible(ctx, 'routes');
        const interview = await seedInterview(ctx, seeded.bookId, seeded.characterId, 'routes');
        const routes = routeHandlerFiles().filter((f) => f.startsWith('src/app/api/w/[workspaceSlug]/books/[bookId]/'));
        expect(routes.length).toBeGreaterThanOrEqual(10);
        const value = (p: string) =>
            ({
                workspaceSlug: owner.workspaceSlug,
                bookId: seeded.bookId,
                elementId: seeded.characterId,
                relationId: seeded.relationId,
                versionNumber: '1',
                sessionId: interview.sessionId,
                questionId: interview.questionId,
                roundNumber: '1',
            })[p] ?? `probe-${p}`;
        const call = async (file: string, method: string) => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const handler = (require(path.join(REPO_ROOT, file)) as Record<string, (req: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>>)[method];
            const { url, params } = urlAndParamsFor(file, value);
            // A VALID request for each: a 404 must be about the deletion, not a malformed body.
            const tail = file.replace('src/app/api/w/[workspaceSlug]/books/[bookId]/', '');
            const valid: Record<string, unknown> = {
                'POST elements/route.ts': { kind: 'THEME', name: 'After deletion' },
                'PATCH elements/[elementId]/route.ts': { name: 'Renamed', baseVersion: 1 },
                'PUT elements/[elementId]/fields/route.ts': { fields: [{ key: 'role', value: 'Ghost' }], baseVersion: 1 },
                'POST elements/[elementId]/versions/[versionNumber]/restore/route.ts': { baseVersion: 1 },
                'POST import/concept-note/route.ts': { text: 'A note.' },
                'POST relations/route.ts': { fromElementId: seeded.characterId, toElementId: seeded.factionId, type: 'related_to' },
                'PATCH route.ts': { title: 'Renamed book' },
                'POST interviews/route.ts': { scope: 'ELEMENT', elementId: seeded.characterId },
                'POST interviews/[sessionId]/questions/[questionId]/answer/route.ts': { text: 'After deletion.' },
            };
            const body = ['GET', 'DELETE'].includes(method) ? undefined : tail === 'import/bundle/route.ts' ? 'PK\u0005\u0006' : JSON.stringify(valid[`${method} ${tail}`] ?? {});
            return handler(
                new NextRequest(`http://localhost${url}`, {
                    method,
                    headers: { 'content-type': tail === 'import/bundle/route.ts' ? 'application/zip' : 'application/json', 'x-forwarded-for': '198.51.100.81' },
                    body,
                }),
                { params: Promise.resolve(params) },
            );
        };
        const cases = routes.flatMap((file) => exportsOf(readRoute(file), file).handlers.map((h) => ({ file, method: h.method })));
        session.userId = owner.userId;
        // Live, its GETs answer (so a 404 below is about the deletion, not a probe that never resolved).
        for (const c of cases.filter((x) => x.method === 'GET')) expect([c.file, (await call(c.file, c.method)).status]).toEqual([c.file, 200]);
        await deleteBook(ctx, seeded.bookId);
        for (const c of cases) expect([`${c.method} ${c.file}`, (await call(c.file, c.method)).status]).toEqual([`${c.method} ${c.file}`, 404]);
        session.userId = null;
    });

    it('is listed for its OWNER and restored whole within 30 days; past the window it is gone', async () => {
        const seeded = await seedBible(ctx, 'restore');
        const before = await contentsOf(seeded.bookId);
        await deleteBook(ctx, seeded.bookId);
        const listed = (await listDeletedBooks(ctx)).books.find((b) => b.id === seeded.bookId);
        expect(listed?.title).toBe('Book restore');
        await deletedDaysAgo(seeded.bookId, 29);
        await expect(restoreBook(ctx, seeded.bookId)).resolves.toMatchObject({ id: seeded.bookId, title: 'Book restore' });
        expect(await contentsOf(seeded.bookId)).toEqual(before);
        expect((await getElement(ctx, seeded.bookId, seeded.characterId)).relations).toHaveLength(1);
        expect(await prisma.auditLog.count({ where: { action: 'BOOK_RESTORED', entityId: seeded.bookId } })).toBe(1);
        // A live book is not restorable (nothing to restore).
        await expect(restoreBook(ctx, seeded.bookId)).rejects.toBeInstanceOf(NotFoundError);

        await deleteBook(ctx, seeded.bookId);
        await deletedDaysAgo(seeded.bookId, 31);
        expect((await listDeletedBooks(ctx)).books.map((b) => b.id)).not.toContain(seeded.bookId);
        await expect(restoreBook(ctx, seeded.bookId)).rejects.toBeInstanceOf(NotFoundError);
    });
});

describe('the database holds the window, whoever deletes', () => {
    it('refuses deleting a live or still-restorable book for good, even as the owner role; admits a due one and a workspace’s cascade', async () => {
        const live = await seedBible(ctx, 'db-live');
        await expect(prisma.book.delete({ where: { id: live.bookId } })).rejects.toThrow(/BOOK_DELETE_NOT_DUE/);
        const recent = await seedBible(ctx, 'db-recent');
        await deleteBook(ctx, recent.bookId);
        await deletedDaysAgo(recent.bookId, 29);
        await expect(prisma.$executeRaw`DELETE FROM "Book" WHERE "id" = ${recent.bookId}`).rejects.toThrow(/BOOK_DELETE_NOT_DUE/);
        expect(await contentsOf(recent.bookId)).toMatchObject({ elements: 2, versions: 2 });
        await deletedDaysAgo(recent.bookId, 31);
        await prisma.book.delete({ where: { id: recent.bookId } });
        expect(await contentsOf(recent.bookId)).toMatchObject({ elements: 0, versions: 0 });

        const other = await createAccount();
        const book = await seedBible(workspaceCtx(other), 'db-cascade');
        await prisma.workspace.delete({ where: { id: other.workspaceId } });
        expect(await prisma.book.findUnique({ where: { id: book.bookId } })).toBeNull();
    });
});

describe('the database’s window is UTC, whatever the session’s time zone', () => {
    const HOUR = 60 * 60 * 1000;
    /** Delete the book for good as the superuser, in a session set to `zone`. */
    const deleteIn = (zone: string, bookId: string) =>
        prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
            await tx.$executeRaw`DELETE FROM "Book" WHERE "id" = ${bookId}`;
        });
    const deletedAgo = (bookId: string, ms: number) => prisma.book.update({ where: { id: bookId }, data: { deletedAt: new Date(Date.now() - ms) } });

    it('a session twelve hours east still may not delete a book three hours short of the window', async () => {
        const book = await seedBible(ctx, 'tz-east');
        await deleteBook(ctx, book.bookId);
        await deletedAgo(book.bookId, 30 * DAY - 3 * HOUR);
        await expect(deleteIn('Etc/GMT-12', book.bookId)).rejects.toThrow(/BOOK_DELETE_NOT_DUE/);
        expect(await prisma.book.findUnique({ where: { id: book.bookId }, select: { id: true } })).not.toBeNull();
    });

    it('a session twelve hours west may delete a book three hours past it', async () => {
        const book = await seedBible(ctx, 'tz-west');
        await deleteBook(ctx, book.bookId);
        await deletedAgo(book.bookId, 30 * DAY + 3 * HOUR);
        await deleteIn('Etc/GMT+12', book.bookId);
        expect(await prisma.book.findUnique({ where: { id: book.bookId } })).toBeNull();
    });
});

describe('the purge', () => {
    it('deletes for good only what was deleted more than 30 days ago, with everything in it, and audits it as the system', async () => {
        const due = await seedBible(ctx, 'due');
        await seedVectors(ctx, due.bookId, 'due');
        const recent = await seedBible(ctx, 'recent');
        const live = await seedBible(ctx, 'live');
        expect((await contentsOf(due.bookId)).vectors).toBeGreaterThan(0);
        await deleteBook(ctx, due.bookId);
        await deleteBook(ctx, recent.bookId);
        await deletedDaysAgo(due.bookId, 31);
        await deletedDaysAgo(recent.bookId, 29);
        const liveBefore = await contentsOf(live.bookId);
        const recentBefore = await contentsOf(recent.bookId);
        const dueBefore = await contentsOf(due.bookId);

        const result = await purgeDeletedBooks();
        expect(result.purged).toBeGreaterThanOrEqual(1);
        expect(result.failed).toBe(0);
        expect(await prisma.book.findUnique({ where: { id: due.bookId } })).toBeNull();
        expect(await contentsOf(due.bookId)).toEqual({ elements: 0, fields: 0, relations: 0, versions: 0, vectors: 0 });
        expect(await contentsOf(recent.bookId)).toEqual(recentBefore);
        expect(await contentsOf(live.bookId)).toEqual(liveBefore);

        const row = await prisma.auditLog.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, action: 'BOOK_PURGED', entityId: due.bookId } });
        expect(row.actorType).toBe('SYSTEM');
        expect(row.actorUserId).toBeNull();
        expect(row.detailsJson).toEqual({ elements: dueBefore.elements, relations: dueBefore.relations, versions: dueBefore.versions });
        // Idempotent: purged once, never found again.
        expect((await purgeDeletedBooks()).due).toBe(0);
    });

    it('skips a book restored after it was found due, and purges a second book of the same run', async () => {
        const a = await seedBible(ctx, 'race-a');
        const b = await seedBible(ctx, 'race-b');
        for (const id of [a.bookId, b.bookId]) {
            await deleteBook(ctx, id);
            await deletedDaysAgo(id, 40);
        }
        // A transaction outside the product holds book A's row: the purge FINDS A due,
        // then waits on A's lock; meanwhile A is restored and the restore commits.
        let purging: ReturnType<typeof purgeDeletedBooks> | undefined;
        await prisma.$transaction(
            async (tx) => {
                await tx.$queryRaw`SELECT 1 FROM "Book" WHERE "id" = ${a.bookId} FOR UPDATE`;
                purging = purgeDeletedBooks();
                purging.catch(() => undefined);
                await waitForRowLockWait('FOR UPDATE');
                await tx.$executeRaw`UPDATE "Book" SET "deletedAt" = NULL WHERE "id" = ${a.bookId}`;
            },
            { timeout: 20_000 },
        );
        const result = await purging!;
        // The purge's own re-check under the lock leaves A: skipped, not failed (the trigger
        // would refuse deleting a live book too, but as a failure, logged as an error).
        expect(result.skipped).toBeGreaterThanOrEqual(1);
        expect(result.failed).toBe(0);
        expect(await prisma.book.findUnique({ where: { id: a.bookId }, select: { deletedAt: true } })).toEqual({ deletedAt: null });
        expect(await contentsOf(a.bookId)).toMatchObject({ elements: 2, versions: 2 });
        expect(await prisma.auditLog.count({ where: { action: 'BOOK_PURGED', entityId: a.bookId } })).toBe(0);
        expect(await prisma.book.findUnique({ where: { id: b.bookId } })).toBeNull();
    });

    it('two purges at once (two schedulers) purge each book once, with one audit row', async () => {
        const books = [await seedBible(ctx, 'twice-a'), await seedBible(ctx, 'twice-b')];
        for (const { bookId } of books) {
            await deleteBook(ctx, bookId);
            await deletedDaysAgo(bookId, 35);
        }
        const [one, two] = await Promise.all([purgeDeletedBooks(), purgeDeletedBooks()]);
        expect(one.failed + two.failed).toBe(0);
        for (const { bookId } of books) {
            expect(await prisma.book.findUnique({ where: { id: bookId } })).toBeNull();
            expect(await prisma.auditLog.count({ where: { action: 'BOOK_PURGED', entityId: bookId } })).toBe(1);
        }
    });

    it('runs as the book-purge job, through the executor registry', async () => {
        const doomed = await seedBible(ctx, 'job');
        await deleteBook(ctx, doomed.bookId);
        await deletedDaysAgo(doomed.bookId, 45);
        const result = await executorRegistry.execute('book-purge', {});
        expect(result).toMatchObject({ jobName: 'book-purge', success: true });
        expect(result.itemsActioned).toBeGreaterThanOrEqual(1);
        expect(await prisma.book.findUnique({ where: { id: doomed.bookId } })).toBeNull();
    });
});

/** Until another backend waits on a row lock in a statement containing `fragment`. */
async function waitForRowLockWait(fragment: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
        const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
            SELECT count(*) AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND datname = current_database() AND query ILIKE ${'%' + fragment + '%'}`;
        if (Number(rows[0].n) > 0) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('nothing ever waited on the row');
}
