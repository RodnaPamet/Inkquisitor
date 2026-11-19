/**
 * Every non-public API route refuses a caller it should refuse — called, not
 * read (Phase 0.H, brief item 1). The structural twin is
 * tests/guards/api-route-authorization.test.ts; both take the route list and
 * its classes from tests/helpers/api-routes.ts, so a new route is called here
 * the day it lands.
 *
 *   every workspace and account handler, no session      → 401
 *   every workspace handler, a signed-in non-member      → 404 (the answer a
 *                                                           missing workspace gets)
 *   every workspace handler, a member without the key    → 403, with an
 *                                                           AUTHZ_DENIED row
 *
 * The session is the one seam (`auth()`), as in members.test.ts; the database
 * membership check and everything behind it are real.
 */
const session: { userId: string | null } = { userId: null };
jest.mock('@/auth', () => ({
    auth: async () => (session.userId ? { user: { id: session.userId, email: 'x@example.test', name: null }, expires: '' } : null),
}));

import * as path from 'node:path';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { ALL_PERMISSION_KEYS, getPermissionsForRole, hasPermission, type PermissionKey } from '@/lib/permissions';
import { classifyRoute, exportsOf, permissionKeyOf, readRoute, routeHandlerFiles, urlAndParamsFor } from '../helpers/api-routes';
import { REPO_ROOT } from '../helpers/repo-files';
import { addMember, createAccount, createBareUser } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const routes = routeHandlerFiles()
    .map((file) => ({ file, cls: classifyRoute(file) }))
    .filter((r) => r.cls === 'workspace' || r.cls === 'account');

function load(file: string): Record<string, Handler> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(path.join(REPO_ROOT, file)) as Record<string, Handler>;
}

function call(handler: Handler, method: string, file: string, slug: string): Promise<Response> {
    const { url, params } = urlAndParamsFor(file, (p) => (p === 'workspaceSlug' ? slug : `probe-${p}`));
    const hasBody = !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(method);
    const req = new NextRequest(`http://localhost${url}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.30' },
        body: hasBody ? '{}' : undefined,
    });
    return handler(req, { params: Promise.resolve(params) });
}

const cases = routes.flatMap(({ file, cls }) =>
    exportsOf(readRoute(file), file).handlers.map((h) => ({ file, cls, method: h.method, key: permissionKeyOf(h.init) })),
);

it('there are routes to call (a list that found none would pass vacuously)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(cases.some((c) => c.cls === 'workspace')).toBe(true);
    expect(cases.some((c) => c.cls === 'account')).toBe(true);
});

describe('signed out', () => {
    it.each(cases.map((c) => [`${c.method} ${c.file}`, c] as const))('%s → 401', async (_label, c) => {
        session.userId = null;
        const res = await call(load(c.file)[c.method], c.method, c.file, 'any-workspace');
        expect(res.status).toBe(401);
    });
});

describe('workspace routes', () => {
    let owner: Awaited<ReturnType<typeof createAccount>>;
    let stranger: Awaited<ReturnType<typeof createAccount>>;
    let reader: { id: string };

    beforeAll(async () => {
        owner = await createAccount();
        stranger = await createAccount();
        reader = await createBareUser();
        await addMember(owner.workspaceId, reader.id, 'READER');
    });

    const workspaceCases = cases.filter((c) => c.cls === 'workspace');

    it.each(workspaceCases.map((c) => [`${c.method} ${c.file}`, c] as const))('%s → 404 for a signed-in non-member', async (_label, c) => {
        session.userId = stranger.userId;
        expect((await call(load(c.file)[c.method], c.method, c.file, owner.workspaceSlug)).status).toBe(404);
        expect((await call(load(c.file)[c.method], c.method, c.file, 'no-such-workspace-slug')).status).toBe(404);
    });

    const readerRefused = workspaceCases.filter(
        (c) => (ALL_PERMISSION_KEYS as readonly string[]).includes(c.key ?? '') && !hasPermission(getPermissionsForRole('READER'), c.key as PermissionKey),
    );

    it('some handler needs a key a READER lacks (else the next case checks nothing)', () => {
        expect(readerRefused.length).toBeGreaterThan(0);
    });

    it.each(readerRefused.map((c) => [`${c.method} ${c.file}`, c] as const))('%s → 403 and AUTHZ_DENIED for a READER', async (_label, c) => {
        session.userId = reader.id;
        const denied = () => prisma.auditLog.count({ where: { workspaceId: owner.workspaceId, action: 'AUTHZ_DENIED', actorUserId: reader.id } });
        const before = await denied();
        expect((await call(load(c.file)[c.method], c.method, c.file, owner.workspaceSlug)).status).toBe(403);
        expect(await denied()).toBe(before + 1);
    });
});
