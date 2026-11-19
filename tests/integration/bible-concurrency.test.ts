/**
 * The bible under concurrent writes (Phase 1.1 review): what the usecases'
 * read-then-write checks cannot hold alone, the database holds, and the
 * usecase answers it as the author expects.
 *
 *   - two creations of one symmetric relation from its two ends store ONE
 *     row (the partial unique index over the unordered pair), the other is
 *     a 409 RELATION_EXISTS;
 *   - a derived slug never collides for good: long names whose suffix
 *     shortens the base, and concurrent creates of one name, all succeed;
 *   - a restore whose old slug is taken between its check and its write keeps
 *     the current slug rather than failing;
 *   - an import compares each element with its state UNDER the element's lock
 *     (Phase 1.H): a save that lands between the import's lookup and its lock
 *     is overwritten by the file, never mistaken for the file's own value.
 */
import { prisma } from '@/lib/db';
import { createElement, getElement, updateElement } from '@/app-layer/usecases/bible-elements';
import { importBibleBundle, importConceptNote, type ImportDeps } from '@/app-layer/usecases/bible-import';
import { addRelation } from '@/app-layer/usecases/bible-relations';
import { restoreVersion } from '@/app-layer/usecases/bible-versions';
import { createBook } from '@/app-layer/usecases/books';
import { writeZip } from '@/lib/archive/zip';
import { ConflictError } from '@/lib/errors/types';
import type { ScanResult } from '@/lib/storage/av-scan';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let ctx: ReturnType<typeof workspaceCtx>;
let account: Awaited<ReturnType<typeof createAccount>>;
let bookId: string;

beforeAll(async () => {
    account = await createAccount();
    ctx = workspaceCtx(account);
    bookId = (await createBook(ctx, { title: 'Concurrency book' })).id;
});

describe('symmetric relations', () => {
    it.each([
        ['related_to', 'THEME', 'MOOD'],
        ['sibling_of', 'CHARACTER', 'CHARACTER'],
    ] as const)('A→B and B→A of %s created at once store one row, every time', async (type, kindA, kindB) => {
        for (let round = 0; round < 15; round++) {
            const a = await createElement(ctx, bookId, { kind: kindA, name: `A ${type} ${round}` });
            const b = await createElement(ctx, bookId, { kind: kindB, name: `B ${type} ${round}` });
            const results = await Promise.allSettled([
                addRelation(ctx, bookId, { fromElementId: a.id, toElementId: b.id, type }),
                addRelation(ctx, bookId, { fromElementId: b.id, toElementId: a.id, type }),
            ]);
            expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
            const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
            expect(rejected.reason).toBeInstanceOf(ConflictError);
            expect((rejected.reason as ConflictError).details).toEqual({ reason: 'RELATION_EXISTS' });
            const rows = await prisma.bibleRelation.count({
                where: { type, OR: [{ fromElementId: a.id, toElementId: b.id }, { fromElementId: b.id, toElementId: a.id }] },
            });
            expect(rows).toBe(1);
            // Still read from both ends.
            expect((await getElement(ctx, bookId, a.id)).relations.map((r) => r.other.id)).toEqual([b.id]);
            expect((await getElement(ctx, bookId, b.id)).relations.map((r) => r.other.id)).toEqual([a.id]);
        }
    });

    it('the database refuses the reverse of a symmetric relation whoever writes it', async () => {
        const a = await createElement(ctx, bookId, { kind: 'SETTING', name: 'North quay' });
        const b = await createElement(ctx, bookId, { kind: 'SETTING', name: 'South quay' });
        await addRelation(ctx, bookId, { fromElementId: a.id, toElementId: b.id, type: 'adjoins' });
        await expect(
            prisma.bibleRelation.create({
                data: { workspaceId: account.workspaceId, bookId, fromElementId: b.id, toElementId: a.id, type: 'adjoins', symmetric: true },
            }),
        ).rejects.toMatchObject({ code: 'P2002' });
        await expect(
            prisma.bibleRelation.create({
                data: { workspaceId: account.workspaceId, bookId, fromElementId: b.id, toElementId: a.id, type: 'related_to', symmetric: false },
            }),
        ).rejects.toThrow(/BibleRelation_related_to_symmetric/);
    });

    it('a directed type may still run both ways', async () => {
        const a = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Teacher' });
        const b = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Pupil' });
        await addRelation(ctx, bookId, { fromElementId: a.id, toElementId: b.id, type: 'mentor_of' });
        await expect(addRelation(ctx, bookId, { fromElementId: b.id, toElementId: a.id, type: 'mentor_of' })).resolves.toBeDefined();
    });
});

describe('derived slugs', () => {
    it('three elements with the same 100-character name get three distinct slugs', async () => {
        const name = `${'Long'.repeat(24)}name`; // 100 characters, one word: the slug base is cut at 80
        expect(name).toHaveLength(100);
        const slugs = [];
        for (let i = 0; i < 3; i++) slugs.push((await createElement(ctx, bookId, { kind: 'OBJECT', name })).slug);
        expect(new Set(slugs).size).toBe(3);
        for (const s of slugs) expect(s.length).toBeLessThanOrEqual(80);
    });

    it('concurrent creates of one name all succeed, each with its own slug, every time', async () => {
        for (let round = 0; round < 5; round++) {
            const name = `Harbour lantern ${round}`;
            const created = await Promise.all([1, 2, 3].map(() => createElement(ctx, bookId, { kind: 'OBJECT', name })));
            expect(new Set(created.map((e) => e.slug)).size).toBe(3);
        }
    });

    it('a supplied slug that is taken is still the author’s conflict', async () => {
        await createElement(ctx, bookId, { kind: 'OBJECT', name: 'Key', slug: 'the-key' });
        await expect(createElement(ctx, bookId, { kind: 'OBJECT', name: 'Other key', slug: 'the-key' })).rejects.toBeInstanceOf(ConflictError);
    });
});

describe('restore', () => {
    it('keeps the current slug when another element takes the old one between the check and the write', async () => {
        const el = await createElement(ctx, bookId, { kind: 'THEME', name: 'Loss', slug: 'loss-original' });
        await updateElement(ctx, bookId, el.id, { slug: 'loss-renamed', baseVersion: 1 }); // version 2; version 1 holds `loss-original`

        // A transaction outside the product holds the element's row, so the
        // restore's UPDATE waits AFTER its slug check; meanwhile it gives the
        // old slug to another element and commits.
        let restoring: Promise<Awaited<ReturnType<typeof restoreVersion>>> | undefined;
        await prisma.$transaction(
            async (tx) => {
                await tx.$queryRaw`SELECT 1 FROM "BibleElement" WHERE id = ${el.id} FOR UPDATE`;
                restoring = restoreVersion(ctx, bookId, el.id, 1, { baseVersion: 2 });
                restoring.catch(() => undefined);
                await waitForLockWait();
                await tx.bibleElement.create({
                    data: { workspaceId: account.workspaceId, bookId, kind: 'THEME', name: 'Interloper', slug: 'loss-original' },
                });
            },
            { timeout: 20_000 },
        );

        const result = await restoring!;
        expect(result.slugKept).toBe(true);
        expect(result.restoredFromVersion).toBe(1);
        const after = await getElement(ctx, bookId, el.id);
        expect(after.slug).toBe('loss-renamed');
        expect(after.versionNumber).toBe(3);
    });
});

describe('import', () => {
    const clean: ImportDeps = { scan: async (): Promise<ScanResult> => ({ status: 'CLEAN', engine: 'test', durationMs: 0 }) };

    /**
     * Hold the element's save lock outside the product, start `run`, and once it
     * waits on that lock (after its lookup), rename the element and commit:
     * the save that lands between an import's read and its lock.
     */
    async function renamedWhileWaiting<T>(elementId: string, run: () => Promise<T>): Promise<T> {
        let running: Promise<T> | undefined;
        await prisma.$transaction(
            async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'bible-element:' + elementId}))`;
                running = run();
                running.catch(() => undefined);
                await waitForAdvisoryWait();
                await tx.$executeRaw`UPDATE "BibleElement" SET "name" = 'Renamed meanwhile' WHERE "id" = ${elementId}`;
            },
            { timeout: 20_000 },
        );
        return running!;
    }

    it('a bundle sets the file’s name over a rename made between its lookup and its lock', async () => {
        const el = await createElement(ctx, bookId, { kind: 'THEME', name: 'Tide', slug: 'tide' });
        const bundle = writeZip(
            new Map([
                ['manifest.json', '{"format":"inkquisitor-bible","version":1}\n'],
                ['theme/tide.md', '---\nkind: THEME\nname: Tide\nslug: tide\nstatus: DRAFT\n---\n'],
            ]),
        );
        const report = await renamedWhileWaiting(el.id, () => importBibleBundle(ctx, bookId, bundle, {}, clean));
        expect(report.items).toEqual([expect.objectContaining({ id: el.id, outcome: 'updated', versionNumber: 2 })]);
        expect((await getElement(ctx, bookId, el.id)).name).toBe('Tide');
    });

    it('a concept note does the same for the note it updates', async () => {
        const first = await importConceptNote(ctx, bookId, { text: 'Salt and debt.', name: 'Salt', slug: 'salt-note' }, clean);
        const report = await renamedWhileWaiting(first.element.id, () => importConceptNote(ctx, bookId, { text: 'Salt and debt.', name: 'Salt', slug: 'salt-note' }, clean));
        expect(report).toMatchObject({ outcome: 'updated', versionNumber: 2 });
        expect((await getElement(ctx, bookId, first.element.id)).name).toBe('Salt');
    });
});

/** Until another backend waits on an advisory lock (an element's save lock). */
async function waitForAdvisoryWait(): Promise<void> {
    for (let i = 0; i < 400; i++) {
        const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
            SELECT count(*) AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND datname = current_database()`;
        if (Number(rows[0].n) > 0) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('nothing ever waited on the element’s lock');
}

/** Until another backend waits on a row lock in an UPDATE of an element (the restore's). */
async function waitForLockWait(): Promise<void> {
    for (let i = 0; i < 400; i++) {
        const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
            SELECT count(*) AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND datname = current_database()
               AND query ILIKE '%UPDATE%BibleElement%'`;
        if (Number(rows[0].n) > 0) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the restore never waited on the element row');
}
