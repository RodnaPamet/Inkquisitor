/**
 * Every API route file has an authorization check (Phase 0.H, brief item 1).
 *
 * The classes are tests/helpers/api-routes.ts: a workspace route's every
 * handler is `withApiErrorHandling(requirePermission('<key>', …))` with a key
 * the permission model defines; an account route's every handler awaits
 * `getUserCtx` in its first statement; a public route is on a closed list with
 * a written reason. A route in none of them fails here, and the behavioural
 * twin (tests/integration/api-route-authorization.test.ts) calls every
 * handler without a session.
 *
 * Parsed with the TypeScript compiler, not matched with a regex: a check that
 * only finds the word `requirePermission` in the file would pass a handler
 * that names it in a comment, or wraps one method and not its sibling.
 */
import { ALL_PERMISSION_KEYS } from '@/lib/permissions';
import {
    PUBLIC_ROUTES,
    apiRouteFiles,
    classifyRoute,
    exportsOf,
    firstStatementAwaitsUserCtx,
    permissionKeyOf,
    readRoute,
} from '../helpers/api-routes';
import { REPO_ROOT } from '../helpers/repo-files';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** What is wrong with one route file, or [] when it is authorized as its class demands. */
function problemsOf(file: string, source: string): string[] {
    const cls = classifyRoute(file);
    if (!cls) return ['not classified: put it under /api/w/[workspaceSlug]/ or /api/account/, or list it in PUBLIC_ROUTES with a reason'];
    const { handlers, others } = exportsOf(source, file);
    const problems: string[] = [];
    if (cls !== 'public' && handlers.length === 0) problems.push('exports no handler');
    for (const h of handlers) {
        if (cls === 'workspace') {
            const key = permissionKeyOf(h.init);
            if (key === null) problems.push(`${h.method}: not withApiErrorHandling(requirePermission('<key>', handler))`);
            else if (!(ALL_PERMISSION_KEYS as readonly string[]).includes(key)) problems.push(`${h.method}: unknown permission key '${key}'`);
        } else if (cls === 'account') {
            if (!firstStatementAwaitsUserCtx(h.fn)) problems.push(`${h.method}: its first statement does not await getUserCtx(…)`);
        }
    }
    // Route segment config is the only other export a route may carry.
    const allowed = new Set(['dynamic', 'revalidate', 'runtime', 'fetchCache', 'preferredRegion', 'maxDuration']);
    for (const o of others) if (!allowed.has(o)) problems.push(`exports '${o}', which is neither a handler nor segment config`);
    return problems;
}

describe('every API route is authorized', () => {
    const files = apiRouteFiles();

    it('finds the routes (a walk that found none would pass vacuously)', () => {
        expect(files).toEqual(expect.arrayContaining(['src/app/api/w/[workspaceSlug]/members/route.ts', 'src/app/api/account/sessions/route.ts']));
        expect(files.length).toBeGreaterThanOrEqual(10);
    });

    it('no route file is unclassified or unchecked', () => {
        const report = Object.fromEntries(files.map((f) => [f, problemsOf(f, readRoute(f))]).filter(([, p]) => p.length > 0));
        expect(report).toEqual({});
    });

    it('every public route still exists (the list cannot rot into a hiding place)', () => {
        for (const file of Object.keys(PUBLIC_ROUTES)) expect([file, fs.existsSync(path.join(REPO_ROOT, file))]).toEqual([file, true]);
    });

    it('the probes reach no usecase, repository or database client', () => {
        for (const probe of ['health', 'livez', 'readyz']) {
            const src = readRoute(`src/app/api/${probe}/route.ts`);
            expect([probe, /from '@\/(?:app-layer|lib\/db)/.test(src)]).toEqual([probe, false]);
        }
    });
});

describe('the checker refuses what it is meant to', () => {
    const W = 'src/app/api/w/[workspaceSlug]/things/route.ts';
    const A = 'src/app/api/account/things/route.ts';

    it('a workspace handler without requirePermission, beside one with it', () => {
        const src = `
            export const GET = withApiErrorHandling(requirePermission('members.view', async () => ok()));
            export const POST = withApiErrorHandling(async () => ok()); // requirePermission('members.manage')
        `;
        expect(problemsOf(W, src)).toEqual(["POST: not withApiErrorHandling(requirePermission('<key>', handler))"]);
    });

    it('an unknown key, a function export and a bare export', () => {
        expect(problemsOf(W, `export const GET = withApiErrorHandling(requirePermission('books.everything', h));`)).toEqual([
            "GET: unknown permission key 'books.everything'",
        ]);
        expect(problemsOf(W, 'export async function GET() { return ok(); }')).toHaveLength(1);
        expect(problemsOf(W, 'export const helper = 1; export const GET = withApiErrorHandling(requirePermission("members.view", h));')).toEqual([
            "exports 'helper', which is neither a handler nor segment config",
        ]);
    });

    it('an account handler that reads a session only after doing work, or never', () => {
        expect(problemsOf(A, 'export const GET = withApiErrorHandling(async (req) => { const ctx = await getUserCtx(req); return ok(ctx); });')).toEqual([]);
        expect(problemsOf(A, 'export const GET = withApiErrorHandling(async (req) => { await doWork(); const ctx = await getUserCtx(req); return ok(ctx); });')).toEqual([
            'GET: its first statement does not await getUserCtx(…)',
        ]);
        expect(problemsOf(A, 'export const GET = withApiErrorHandling(async () => ok());')).toHaveLength(1);
    });

    it('a route outside every class', () => {
        expect(problemsOf('src/app/api/books/route.ts', 'export const GET = withApiErrorHandling(requirePermission("members.view", h));')).toHaveLength(1);
    });
});
