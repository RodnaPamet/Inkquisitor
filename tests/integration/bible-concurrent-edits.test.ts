/**
 * Two writers on one element (Phase 1.H, item 2): the optimistic version
 * check. A save names the version its edit is based on; under the element's
 * lock, a newer version refuses it 409 VERSION_CONFLICT with the version the
 * element is at, and NOTHING is written — no field, no column, no version, no
 * audit row. One writer never silently overwrites the other.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { createElement, getElement, updateElement, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { restoreVersion } from '@/app-layer/usecases/bible-versions';
import { createBook } from '@/app-layer/usecases/books';
import { ZodError } from 'zod';
import { ConflictError, ValidationError } from '@/lib/errors/types';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

const session: { userId: string | null } = { userId: null };
jest.mock('@/auth', () => ({
    auth: async () => (session.userId ? { user: { id: session.userId, email: 'x@example.test', name: null }, expires: '' } : null),
}));

afterAll(() => prisma.$disconnect());

let owner: Awaited<ReturnType<typeof createAccount>>;
let alice: ReturnType<typeof workspaceCtx>;
let bob: ReturnType<typeof workspaceCtx>;
let bookId: string;

beforeAll(async () => {
    owner = await createAccount();
    alice = workspaceCtx(owner);
    const editor = await createBareUser();
    await addMember(owner.workspaceId, editor.id, 'EDITOR');
    bob = { ...workspaceCtx(owner, 'EDITOR'), userId: editor.id };
    bookId = (await createBook(alice, { title: 'Two writers' })).id;
});

const versions = (elementId: string) => prisma.bibleEntryVersion.count({ where: { elementId } });
const audits = (elementId: string) => prisma.auditLog.count({ where: { entityId: elementId } });

async function conflictOf(p: Promise<unknown>): Promise<Record<string, unknown>> {
    const err = await p.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictError);
    return (err as ConflictError).details as Record<string, unknown>;
}

describe('two writers from one base version', () => {
    it('the first save wins; the second is refused with the current version, and writes nothing at all', async () => {
        const el = await createElement(alice, bookId, { kind: 'CHARACTER', name: 'Mara', fields: [{ key: 'role', value: 'Ferrywoman' }] });
        expect(el.versionNumber).toBe(1);
        // Both open version 1.
        const saved = await updateElementFields(alice, bookId, el.id, { fields: [{ key: 'role', value: 'Pilot' }], baseVersion: 1 });
        expect(saved.versionNumber).toBe(2);
        const [v, a] = [await versions(el.id), await audits(el.id)];

        const details = await conflictOf(updateElementFields(bob, bookId, el.id, { fields: [{ key: 'role', value: 'Smuggler' }, { key: 'want', value: 'Gold' }], baseVersion: 1 }));
        expect(details).toEqual({ reason: 'VERSION_CONFLICT', currentVersion: 2, baseVersion: 1 });
        expect(await versions(el.id)).toBe(v);
        expect(await audits(el.id)).toBe(a);
        const now = await getElement(alice, bookId, el.id);
        expect(now.fields.find((f) => f.key === 'role')?.value).toBe('Pilot');
        expect(now.fields.find((f) => f.key === 'want')?.value).toBeNull();

        // Bob, re-based on version 2 (the "keep my edits" answer), saves over it knowingly.
        const over = await updateElementFields(bob, bookId, el.id, { fields: [{ key: 'role', value: 'Smuggler' }], baseVersion: 2 });
        expect(over.versionNumber).toBe(3);
        expect((await getElement(alice, bookId, el.id)).fields.find((f) => f.key === 'role')?.value).toBe('Smuggler');
    });

    it('holds for the element’s own columns (PATCH) and for a restore', async () => {
        const el = await createElement(alice, bookId, { kind: 'THEME', name: 'Debt' });
        await updateElement(alice, bookId, el.id, { summary: 'What is owed', baseVersion: 1 });
        const before = await versions(el.id);
        expect(await conflictOf(updateElement(bob, bookId, el.id, { name: 'Credit', baseVersion: 1 }))).toMatchObject({ reason: 'VERSION_CONFLICT', currentVersion: 2 });
        expect(await conflictOf(restoreVersion(bob, bookId, el.id, 1, { baseVersion: 1 }))).toMatchObject({ reason: 'VERSION_CONFLICT', currentVersion: 2 });
        expect(await versions(el.id)).toBe(before);
        expect((await getElement(alice, bookId, el.id)).name).toBe('Debt');
        // On the current base both go through.
        const restored = await restoreVersion(bob, bookId, el.id, 1, { baseVersion: 2 });
        expect(restored.version.versionNumber).toBe(3);
        await expect(updateElement(alice, bookId, el.id, { name: 'Credit', baseVersion: 3 })).resolves.toMatchObject({ name: 'Credit', versionNumber: 4 });
    });

    it('a save that would change nothing is still refused on a stale base (its answer would re-base the writer silently)', async () => {
        const el = await createElement(alice, bookId, { kind: 'MOOD', name: 'Dread' });
        await updateElement(alice, bookId, el.id, { summary: 'cold', baseVersion: 1 });
        await conflictOf(updateElement(bob, bookId, el.id, { summary: 'cold', baseVersion: 1 }));
    });

    it('two saves sent at once on one base: exactly one is applied, the other refused, one version written', async () => {
        for (let round = 0; round < 10; round++) {
            const el = await createElement(alice, bookId, { kind: 'CHARACTER', name: `Racer ${round}` });
            const results = await Promise.allSettled([
                updateElementFields(alice, bookId, el.id, { fields: [{ key: 'role', value: 'Alice’s' }], baseVersion: 1 }),
                updateElementFields(bob, bookId, el.id, { fields: [{ key: 'role', value: 'Bob’s' }], baseVersion: 1 }),
            ]);
            expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
            const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
            expect((refused.reason as ConflictError).details).toMatchObject({ reason: 'VERSION_CONFLICT', currentVersion: 2 });
            expect(await versions(el.id)).toBe(2);
            const winner = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ fields: Array<{ key: string; value: unknown }> }>).value;
            expect((await getElement(alice, bookId, el.id)).fields.find((f) => f.key === 'role')?.value).toBe(winner.fields.find((f) => f.key === 'role')?.value);
        }
    });

    it('a save that names no base is refused, writing nothing: the check cannot be skipped by leaving it out', async () => {
        const el = await createElement(alice, bookId, { kind: 'SETTING', name: 'Harbour' });
        await updateElement(alice, bookId, el.id, { summary: 'grey', baseVersion: 1 });
        const [v, a] = [await versions(el.id), await audits(el.id)];
        for (const omitted of [
            updateElement(bob, bookId, el.id, { summary: 'green' }),
            updateElementFields(bob, bookId, el.id, { fields: [{ key: 'era', value: 'later' }] }),
            restoreVersion(bob, bookId, el.id, 1, {}),
            restoreVersion(bob, bookId, el.id, 1, undefined),
        ]) {
            const err = await omitted.catch((e: unknown) => e);
            expect(err).toBeInstanceOf(ZodError);
        }
        expect([await versions(el.id), await audits(el.id)]).toEqual([v, a]);
        expect((await getElement(alice, bookId, el.id)).summary).toBe('grey');
    });

    it('a base out of range is a 400, never a query error; baseVersion alone is nothing to change', async () => {
        const el = await createElement(alice, bookId, { kind: 'SETTING', name: 'Quay' });
        await expect(updateElement(alice, bookId, el.id, { summary: 'x', baseVersion: 2 ** 31 })).rejects.toThrow();
        await expect(updateElement(alice, bookId, el.id, { summary: 'x', baseVersion: 0 })).rejects.toThrow();
        await expect(updateElement(alice, bookId, el.id, { baseVersion: 1 })).rejects.toThrow();
        const err = await updateElementFields(alice, bookId, el.id, { fields: [{ key: 'era', value: 'x' }], baseVersion: 1.5 }).catch((e: unknown) => e);
        expect(err).not.toBeInstanceOf(ValidationError); // a Zod error, answered 400 by the route
        expect(await versions(el.id)).toBe(1);
    });
});

describe('through the route', () => {
    it('PUT …/fields with a stale base is a 409 naming VERSION_CONFLICT and the current version', async () => {
        const el = await createElement(alice, bookId, { kind: 'CHARACTER', name: 'Routed' });
        await updateElementFields(alice, bookId, el.id, { fields: [{ key: 'role', value: 'first' }], baseVersion: 1 });
        session.userId = bob.userId;
        const { PUT } = await import('@/app/api/w/[workspaceSlug]/books/[bookId]/elements/[elementId]/fields/route');
        const res = await PUT(
            new NextRequest(`http://localhost/api/w/${owner.workspaceSlug}/books/${bookId}/elements/${el.id}/fields`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.44' },
                body: JSON.stringify({ fields: [{ key: 'role', value: 'second' }], baseVersion: 1 }),
            }),
            { params: Promise.resolve({ workspaceSlug: owner.workspaceSlug, bookId, elementId: el.id }) },
        );
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { details: unknown } };
        expect(body.error.details).toEqual({ reason: 'VERSION_CONFLICT', currentVersion: 2, baseVersion: 1 });
        expect(await versions(el.id)).toBe(2);
    });

    it('every saving route refuses a request that names no base (400), writing nothing', async () => {
        const el = await createElement(alice, bookId, { kind: 'CHARACTER', name: 'Unbased' });
        session.userId = bob.userId;
        const base = `http://localhost/api/w/${owner.workspaceSlug}/books/${bookId}/elements/${el.id}`;
        const params = { workspaceSlug: owner.workspaceSlug, bookId, elementId: el.id };
        const send = (url: string, method: string, body?: unknown) =>
            new NextRequest(url, {
                method,
                headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.45' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        const element = await import('@/app/api/w/[workspaceSlug]/books/[bookId]/elements/[elementId]/route');
        const fields = await import('@/app/api/w/[workspaceSlug]/books/[bookId]/elements/[elementId]/fields/route');
        const restore = await import('@/app/api/w/[workspaceSlug]/books/[bookId]/elements/[elementId]/versions/[versionNumber]/restore/route');
        const statuses = [
            (await element.PATCH(send(base, 'PATCH', { name: 'Overwritten' }), { params: Promise.resolve(params) })).status,
            (await fields.PUT(send(`${base}/fields`, 'PUT', { fields: [{ key: 'role', value: 'Overwritten' }] }), { params: Promise.resolve(params) })).status,
            (await restore.POST(send(`${base}/versions/1/restore`, 'POST', {}), { params: Promise.resolve({ ...params, versionNumber: '1' }) })).status,
            (await restore.POST(send(`${base}/versions/1/restore`, 'POST'), { params: Promise.resolve({ ...params, versionNumber: '1' }) })).status,
        ];
        expect(statuses).toEqual([400, 400, 400, 400]);
        expect(await versions(el.id)).toBe(1);
        expect((await getElement(alice, bookId, el.id)).name).toBe('Unbased');
    });
});
