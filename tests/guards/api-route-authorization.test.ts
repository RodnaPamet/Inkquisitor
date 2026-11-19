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
    classifyRoute,
    exportsOf,
    isAccountHandlerShape,
    permissionKeyOf,
    readRoute,
    routeHandlerFiles,
    routeHandlerFilesAmong,
} from '../helpers/api-routes';
import { REPO_ROOT } from '../helpers/repo-files';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** What is wrong with one route file, or [] when it is authorized as its class demands. */
function problemsOf(file: string, source: string): string[] {
    const cls = classifyRoute(file);
    if (!cls) {
        return [
            'not classified: a route handler is a .ts file under src/app/api/w/[workspaceSlug]/ or src/app/api/account/, or is listed in PUBLIC_ROUTES with a reason',
        ];
    }
    const { handlers, others, unreadable } = exportsOf(source, file);
    const problems: string[] = unreadable.map((u) => `${u}: an export the checker cannot read (export each handler as \`export const <METHOD> = …\`)`);
    if (cls !== 'public' && handlers.length === 0) problems.push('exports no handler');
    for (const h of handlers) {
        if (cls === 'workspace') {
            const key = permissionKeyOf(h.init);
            if (key === null) problems.push(`${h.method}: not withApiErrorHandling(requirePermission('<key>', handler))`);
            else if (!(ALL_PERMISSION_KEYS as readonly string[]).includes(key)) problems.push(`${h.method}: unknown permission key '${key}'`);
        } else if (cls === 'account') {
            if (!isAccountHandlerShape(h.init)) {
                problems.push(`${h.method}: not withApiErrorHandling(async (req) => { const ctx = await getUserCtx(req); … })`);
            }
        }
    }
    // Route segment config is the only other export a route may carry.
    const allowed = new Set(['dynamic', 'revalidate', 'runtime', 'fetchCache', 'preferredRegion', 'maxDuration']);
    for (const o of others) if (!allowed.has(o)) problems.push(`exports '${o}', which is neither a handler nor segment config`);
    return problems;
}

describe('every API route is authorized', () => {
    const files = routeHandlerFiles();

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
            'GET: not withApiErrorHandling(async (req) => { const ctx = await getUserCtx(req); … })',
        ]);
        expect(problemsOf(A, 'export const GET = withApiErrorHandling(async () => ok());')).toHaveLength(1);
    });

    it('a route outside every class', () => {
        expect(problemsOf('src/app/api/books/route.ts', 'export const GET = withApiErrorHandling(requirePermission("members.view", h));')).toHaveLength(1);
    });

    const KEYED = 'withApiErrorHandling(requirePermission("members.view", h))';

    it('a destructured export, export let / var and export default are refused, not skipped', () => {
        expect(problemsOf(W, `const h = { POST: async () => ok() }; export const { POST } = h; export const GET = ${KEYED};`)).toEqual([
            expect.stringMatching(/^destructured export \(\{ POST \}\)/),
        ]);
        expect(problemsOf(W, 'const h = [async () => ok()]; export const [DELETE] = h;')).toEqual([
            expect.stringMatching(/^destructured export/),
            'exports no handler',
        ]);
        expect(problemsOf(W, `export let GET = ${KEYED}; GET = async () => ok();`)).toEqual([expect.stringMatching(/^export let GET/), 'exports no handler']);
        expect(problemsOf(W, `export var GET = ${KEYED};`)).toEqual([expect.stringMatching(/^export var GET/), 'exports no handler']);
        expect(problemsOf(W, `export const GET = ${KEYED}; export default async function POST() { return ok(); }`)).toEqual([
            expect.stringMatching(/^export default/),
        ]);
        expect(problemsOf(W, `export const GET = ${KEYED}; const h = 1; export default h;`)).toEqual([expect.stringMatching(/^export default/)]);
        expect(problemsOf(W, `export const GET = ${KEYED}; export { POST } from './elsewhere';`)).toEqual([expect.stringMatching(/^export … from/)]);
        expect(problemsOf(W, `const POST = async () => ok(); export { POST }; export const GET = ${KEYED};`)).toEqual([
            expect.stringMatching(/^export \{ … \}/),
        ]);
        expect(problemsOf(W, `export const GET = ${KEYED}; export class POST {}`)).toEqual([expect.stringMatching(/^exported ClassDeclaration/)]);
        // Types are erased and are not exports at run time.
        expect(problemsOf(W, `export type T = string; export interface I { a: 1 } export const GET = ${KEYED};`)).toEqual([]);
    });

    it('every route file Next could serve is listed, wherever it lives', () => {
        const tree = [
            'src/app/api/w/[workspaceSlug]/members/route.ts',
            'src/app/w/[workspaceSlug]/export/route.ts',
            'src/app/(marketing)/api/hook/route.ts',
            'src/app/feed.xml/route.js',
            'src/app/route.ts',
            'app/api/x/route.ts',
            'src/pages/api/legacy.ts',
            'pages/api/nested/thing.js',
            'src/app/w/[workspaceSlug]/page.tsx',
            'src/lib/route.ts',
            'src/pages/about.tsx',
        ];
        expect(routeHandlerFilesAmong(tree)).toEqual([
            'app/api/x/route.ts',
            'pages/api/nested/thing.js',
            'src/app/(marketing)/api/hook/route.ts',
            'src/app/api/w/[workspaceSlug]/members/route.ts',
            'src/app/feed.xml/route.js',
            'src/app/route.ts',
            'src/app/w/[workspaceSlug]/export/route.ts',
            'src/pages/api/legacy.ts',
        ]);
        // Every one outside src/app/api is unclassified, so it fails rather than passing unread.
        for (const f of routeHandlerFilesAmong(tree).filter((f) => !f.startsWith('src/app/api/'))) {
            expect([f, problemsOf(f, `export const GET = ${KEYED};`)]).toEqual([f, [expect.stringMatching(/^not classified/)]]);
        }
        expect(problemsOf('src/app/api/w/[workspaceSlug]/x/route.js', `export const GET = ${KEYED};`)).toEqual([expect.stringMatching(/^not classified/)]);
    });

    it('an account handler must be wrapped, and its first statement must be exactly `const x = await getUserCtx(…)`', () => {
        const ok = 'export const GET = withApiErrorHandling(async (req) => { const ctx = await getUserCtx(req); return ok(ctx); });';
        expect(problemsOf(A, ok)).toEqual([]);
        expect(problemsOf(A, 'export const DELETE = withApiErrorHandling<C>(async (req, { params }) => { const ctx = await getUserCtx(req); return ok(ctx); });')).toEqual([]);
        const refused = [
            // Not wrapped.
            'export const GET = async (req) => { const ctx = await getUserCtx(req); return ok(ctx); };',
            'export async function GET(req) { const ctx = await getUserCtx(req); return ok(ctx); }',
            'export const GET = somethingElse(async (req) => { const ctx = await getUserCtx(req); return ok(ctx); });',
            // An await of getUserCtx somewhere inside the first statement, but not the statement.
            'export const GET = withApiErrorHandling(async (req) => { const ctx = cond ? await getUserCtx(req) : null; return ok(ctx); });',
            'export const GET = withApiErrorHandling(async (req) => { const [w, ctx] = await Promise.all([work(), getUserCtx(req)]); return ok(ctx); });',
            'export const GET = withApiErrorHandling(async (req) => { const r = await work(await getUserCtx(req)); return ok(r); });',
            'export const GET = withApiErrorHandling(async (req) => { if (await getUserCtx(req)) await work(); return ok(); });',
            'export const GET = withApiErrorHandling(async (req) => { await getUserCtx(req); return ok(); });',
            'export const GET = withApiErrorHandling(async (req) => { let ctx = await getUserCtx(req); return ok(ctx); });',
            'export const GET = withApiErrorHandling(async (req) => { const ctx = await getUserCtx(req), w = await work(); return ok(ctx, w); });',
            'export const GET = withApiErrorHandling(async (req) => { const ctx = getUserCtx(req); return ok(ctx); });',
            'export const GET = withApiErrorHandling(async () => ok(await getUserCtx()));',
        ];
        for (const src of refused) expect([src, problemsOf(A, src)]).toEqual([src, [expect.stringMatching(/^GET: not withApiErrorHandling/)]]);
    });
});
