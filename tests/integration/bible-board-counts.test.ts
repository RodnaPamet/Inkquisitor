/**
 * The element list's filled-field counts, which the book board's
 * completeness is built from (Phase 1.2): per element, how many of its
 * kind's template fields hold a value — through the usecase and through the
 * GET route — with a cleared field no longer counted, a stored key the
 * template does not have never counted, and no other workspace's rows ever
 * read.
 */
const session: { userId: string | null } = { userId: null };
jest.mock('@/auth', () => ({
    auth: async () => (session.userId ? { user: { id: session.userId, email: 'x@example.test', name: null }, expires: '' } : null),
}));

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import * as elementsRoute from '@/app/api/w/[workspaceSlug]/books/[bookId]/elements/route';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, listElements, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

it('counts each element\'s filled template fields, and nothing else', async () => {
    const account = await createAccount();
    const ctx = workspaceCtx(account);
    const book = await createBook(ctx, { title: 'Counting book' });
    const mara = await createElement(ctx, book.id, {
        kind: 'CHARACTER',
        name: 'Mara',
        fields: [
            { key: 'role', value: 'Ferrywoman' },
            { key: 'want', value: 'To cross' },
            { key: 'agency', value: 4 },
        ],
    });
    const guild = await createElement(ctx, book.id, { kind: 'FACTION', name: 'Guild' });

    const byId = async () => Object.fromEntries((await listElements(ctx, book.id)).elements.map((e) => [e.id, e.filledFieldCount]));
    expect(await byId()).toEqual({ [mara.id]: 3, [guild.id]: 0 });

    await updateElementFields(ctx, book.id, mara.id, { fields: [{ key: 'want', value: null }], baseVersion: mara.versionNumber });
    expect((await byId())[mara.id]).toBe(2);

    // A row whose key the CHARACTER template does not have (a template that
    // later dropped a field) is not counted. Written as the superuser, the
    // only way such a row can exist; its value is never read by the count.
    await prisma.$executeRaw`
        INSERT INTO "BibleField" ("id", "workspaceId", "elementId", "key", "value", "order", "updatedAt")
        VALUES (${randomUUID()}, ${account.workspaceId}, ${mara.id}, 'retired_field', 'not-an-envelope', 99, now())`;
    expect((await byId())[mara.id]).toBe(2);

    // The route answers the same counts.
    session.userId = account.userId;
    const req = new NextRequest(`http://localhost/api/w/${account.workspaceSlug}/books/${book.id}/elements`, { headers: { 'x-forwarded-for': '198.51.100.41' } });
    const res = await elementsRoute.GET(req, { params: Promise.resolve({ workspaceSlug: account.workspaceSlug, bookId: book.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { elements: Array<{ id: string; filledFieldCount: number }> };
    expect(Object.fromEntries(body.elements.map((e) => [e.id, e.filledFieldCount]))).toEqual({ [mara.id]: 2, [guild.id]: 0 });
});

it('never counts another workspace\'s fields', async () => {
    const a = await createAccount();
    const b = await createAccount();
    const ctxA = workspaceCtx(a);
    const book = await createBook(ctxA, { title: 'Mine' });
    const el = await createElement(ctxA, book.id, { kind: 'CHARACTER', name: 'Mara', fields: [{ key: 'role', value: 'Ferrywoman' }] });
    // A row in B's workspace naming A's element: refused by the composite
    // foreign key, so the count can only ever see the element's own workspace.
    await expect(
        prisma.$executeRaw`
            INSERT INTO "BibleField" ("id", "workspaceId", "elementId", "key", "value", "order", "updatedAt")
            VALUES (${randomUUID()}, ${b.workspaceId}, ${el.id}, 'want', 'x', 6, now())`,
    ).rejects.toThrow();
    expect((await listElements(ctxA, book.id)).elements.map((e) => e.filledFieldCount)).toEqual([1]);
    await expect(listElements(workspaceCtx(b), book.id)).rejects.toThrow('Book not found.');
});
