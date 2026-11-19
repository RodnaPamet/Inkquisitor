/**
 * Every route file under `src/app/api`, and the authorization class each
 * belongs to — ONE classification, read by the structural guard
 * (tests/guards/api-route-authorization.test.ts) and by the behavioural
 * suite that calls every handler without a session
 * (tests/integration/api-route-authorization.test.ts). A route that is in
 * neither class nor the public list fails both.
 *
 *   workspace  `src/app/api/w/[workspaceSlug]/**`: every handler is
 *              `withApiErrorHandling(requirePermission('<key>', …))`, which
 *              resolves the membership in the database before the handler
 *              runs (401 signed out, 404 not a member, 403 + AUTHZ_DENIED
 *              without the key).
 *   account    `src/app/api/account/**`: self-service on the caller's own
 *              rows. Every handler's first statement awaits `getUserCtx`
 *              (401 signed out); the usecase binds every query to that user.
 *   public     listed below by path, each with the reason it takes no
 *              session. The list is closed: a new public route is a reviewed
 *              entry here, never a prefix.
 *
 * The population comes from git (`repoFiles`), so a route nobody has
 * `git add`-ed yet is classified too.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { REPO_ROOT, repoFiles, repoRelative } from './repo-files';

export type RouteClass = 'workspace' | 'account' | 'public';

export const PUBLIC_ROUTES: Readonly<Record<string, string>> = Object.freeze({
    'src/app/api/health/route.ts': 'Liveness probe: answers during an attack, reads nothing, carries no data.',
    'src/app/api/livez/route.ts': 'Liveness probe: process uptime only.',
    'src/app/api/readyz/route.ts': 'Readiness probe: dependency status in a fixed vocabulary, no data and no driver message.',
    'src/app/api/auth/[...nextauth]/route.ts': 'Sign-in itself (NextAuth): authenticates the caller; LOGIN_LIMIT and the edge auth tier bound it.',
    'src/app/api/auth/register/route.ts': 'Sign-up: creates the caller’s own account and workspace; WORKSPACE_CREATE_LIMIT bounds it.',
});

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/** Every `route.ts` under `src/app/api`, repo-relative. */
export function apiRouteFiles(): string[] {
    return repoFiles({ under: 'src/app/api', extensions: ['.ts', '.tsx', '.js', '.mjs'] })
        .map(repoRelative)
        .filter((f) => /\/route\.(?:ts|tsx|js|mjs)$/.test(f))
        .sort();
}

export function classifyRoute(file: string): RouteClass | null {
    if (file in PUBLIC_ROUTES) return 'public';
    if (file.startsWith('src/app/api/w/[workspaceSlug]/')) return 'workspace';
    if (file.startsWith('src/app/api/account/')) return 'account';
    return null;
}

export interface ExportedHandler {
    method: string;
    /** `const X = <init>` for a variable export, null for `export function X`. */
    init: ts.Expression | null;
    /** The function body, when the export is a function or a call wrapping one. */
    fn: ts.FunctionLikeDeclaration | null;
}

/** The exported HTTP-method handlers of a route module, and every other value it exports. */
export function exportsOf(source: string, fileName = 'route.ts'): { handlers: ExportedHandler[]; others: string[] } {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const handlers: ExportedHandler[] = [];
    const others: string[] = [];
    const isExported = (n: ts.Node) =>
        ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && isExported(st) && st.name) {
            const name = st.name.text;
            if ((HTTP_METHODS as readonly string[]).includes(name)) handlers.push({ method: name, init: null, fn: st });
            else others.push(name);
        } else if (ts.isVariableStatement(st) && isExported(st)) {
            for (const d of st.declarationList.declarations) {
                if (!ts.isIdentifier(d.name)) continue;
                const name = d.name.text;
                if ((HTTP_METHODS as readonly string[]).includes(name)) {
                    handlers.push({ method: name, init: d.initializer ?? null, fn: firstFunctionIn(d.initializer) });
                } else others.push(name);
            }
        } else if (ts.isExportDeclaration(st)) {
            others.push('<re-export>');
        }
    }
    return { handlers, others };
}

function firstFunctionIn(node: ts.Node | undefined): ts.FunctionLikeDeclaration | null {
    if (!node) return null;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
    let found: ts.FunctionLikeDeclaration | null = null;
    node.forEachChild((c) => {
        if (!found) found = firstFunctionIn(c);
    });
    return found;
}

export function calleeName(call: ts.CallExpression): string | null {
    return ts.isIdentifier(call.expression) ? call.expression.text : null;
}

/** The permission key of `withApiErrorHandling(requirePermission('<key>', …))`, or null for any other shape. */
export function permissionKeyOf(init: ts.Expression | null): string | null {
    if (!init || !ts.isCallExpression(init) || calleeName(init) !== 'withApiErrorHandling') return null;
    const inner = init.arguments[0];
    if (!inner || !ts.isCallExpression(inner) || calleeName(inner) !== 'requirePermission') return null;
    const key = inner.arguments[0];
    return key && ts.isStringLiteralLike(key) && inner.arguments.length === 2 ? key.text : null;
}

/** True when the handler's FIRST statement awaits `getUserCtx(…)`. */
export function firstStatementAwaitsUserCtx(fn: ts.FunctionLikeDeclaration | null): boolean {
    if (!fn?.body || !ts.isBlock(fn.body)) return false;
    const first = fn.body.statements[0];
    if (!first) return false;
    let found = false;
    const visit = (n: ts.Node): void => {
        if (ts.isAwaitExpression(n) && ts.isCallExpression(n.expression) && calleeName(n.expression) === 'getUserCtx') found = true;
        if (!ts.isFunctionLike(n)) n.forEachChild(visit);
    };
    first.forEachChild(visit);
    return found;
}

export function readRoute(file: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

/** `src/app/api/a/[b]/route.ts` → `/api/a/<b>` and `{ b: <value> }`. */
export function urlAndParamsFor(file: string, value: (param: string) => string): { url: string; params: Record<string, string> } {
    const segments = file.replace(/^src\/app/, '').replace(/\/route\.\w+$/, '').split('/').filter(Boolean);
    const params: Record<string, string> = {};
    const url = segments
        .map((s) => {
            const m = /^\[([^\].]+)\]$/.exec(s);
            if (!m) return s;
            params[m[1]] = value(m[1]);
            return params[m[1]];
        })
        .join('/');
    return { url: `/${url}`, params };
}
