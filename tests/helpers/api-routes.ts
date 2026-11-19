/**
 * Every route-handler file Next could serve, and the authorization class each
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
 * `git add`-ed yet is classified too. It is EVERY file Next would serve as a
 * handler, not only those under `src/app/api` (Phase 0.H review): a `route.*`
 * anywhere under an app directory (`src/app` and, were it to appear, a
 * top-level `app`, which Next would serve INSTEAD of `src/app`), and every
 * file under a Pages Router `pages/api` (src/ or top level). Anything outside
 * the three classes fails — a route under `src/app/w/[workspaceSlug]/` that
 * the proxy gates but no `requirePermission` checks, a `pages/api` handler,
 * a route group's `(x)/api/…` spelling — rather than going unclassified.
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

/** A route handler's file name, in every extension Next resolves. */
const ROUTE_FILE = /(?:^|\/)route\.(?:[cm]?[jt]sx?)$/;
/** An App Router directory: `src/app` or a top-level `app` (which Next prefers). */
const APP_DIR = /^(?:src\/)?app\//;
/** A Pages Router API directory: every file in it is a handler. */
const PAGES_API_DIR = /^(?:src\/)?pages\/api\//;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** The route-handler files among `files` (repo-relative paths). Pure, so the guard can test it on made-up trees. */
export function routeHandlerFilesAmong(files: readonly string[]): string[] {
    return files
        .filter((f) => (APP_DIR.test(f) && ROUTE_FILE.test(f)) || (PAGES_API_DIR.test(f) && SOURCE_FILE.test(f)))
        .sort();
}

/** Every route-handler file in the repository, repo-relative. */
export function routeHandlerFiles(): string[] {
    return routeHandlerFilesAmong(repoFiles().map(repoRelative));
}

/**
 * The class of a route file, or null. Only `.ts` files under `src/app/api` can
 * be in one: a `.js` handler, a top-level `app/`, `pages/api` and any route
 * outside `src/app/api` are unclassified by construction.
 */
export function classifyRoute(file: string): RouteClass | null {
    if (!/^src\/app\/api\/.*\/route\.ts$/.test(file)) return null;
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

/**
 * The exported HTTP-method handlers of a route module, every other value it
 * exports, and every export the checker cannot read.
 *
 * `unreadable` is a FAILURE, never a skip (Phase 0.H review). A destructured
 * export (`export const { POST } = h`), an `export let` / `export var` (a
 * binding the module can reassign after the check), an `export default`, an
 * `export =`, an exported class, enum or namespace, and an `export … from` or
 * `export { … }` list all used to fall through: the first three exported a
 * handler the guard never looked at.
 */
export function exportsOf(source: string, fileName = 'route.ts'): { handlers: ExportedHandler[]; others: string[]; unreadable: string[] } {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const handlers: ExportedHandler[] = [];
    const others: string[] = [];
    const unreadable: string[] = [];
    const modifiers = (n: ts.Node) => (ts.canHaveModifiers(n) ? (ts.getModifiers(n) ?? []) : []);
    const isExported = (n: ts.Node) => modifiers(n).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = (n: ts.Node) => modifiers(n).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    const isMethod = (name: string) => (HTTP_METHODS as readonly string[]).includes(name);
    for (const st of sf.statements) {
        if (ts.isExportAssignment(st)) {
            unreadable.push(st.isExportEquals ? 'export =' : 'export default');
        } else if (ts.isExportDeclaration(st)) {
            unreadable.push(st.moduleSpecifier ? 'export … from' : 'export { … }');
        } else if (!isExported(st)) {
            continue;
        } else if (isDefault(st)) {
            unreadable.push('export default');
        } else if (ts.isFunctionDeclaration(st)) {
            const name = st.name?.text;
            if (!name) unreadable.push('anonymous exported function');
            else if (isMethod(name)) handlers.push({ method: name, init: null, fn: st });
            else others.push(name);
        } else if (ts.isVariableStatement(st)) {
            const flags = st.declarationList.flags;
            const isConst = isPlainConst(flags);
            for (const d of st.declarationList.declarations) {
                if (!ts.isIdentifier(d.name)) {
                    unreadable.push(`destructured export (${d.name.getText(sf)})`);
                    continue;
                }
                const name = d.name.text;
                if (!isConst) {
                    unreadable.push(`export ${declarationKeyword(flags)} ${name}`);
                    continue;
                }
                if (isMethod(name)) handlers.push({ method: name, init: d.initializer ?? null, fn: firstFunctionIn(d.initializer) });
                else others.push(name);
            }
        } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
            // Types are erased: no runtime export.
            continue;
        } else {
            unreadable.push(`exported ${ts.SyntaxKind[st.kind]}`);
        }
    }
    return { handlers, others, unreadable };
}

/** `const`, and not `let`, `var`, `using` or `await using` (`AwaitUsing` shares `Const`'s bit). */
function isPlainConst(flags: ts.NodeFlags): boolean {
    return (flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const;
}

function declarationKeyword(flags: ts.NodeFlags): string {
    switch (flags & ts.NodeFlags.BlockScoped) {
        case ts.NodeFlags.Let:
            return 'let';
        case ts.NodeFlags.Using:
            return 'using';
        case ts.NodeFlags.AwaitUsing:
            return 'await using';
        default:
            return 'var';
    }
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

/**
 * True when an account handler has the one shape the account class allows:
 * `withApiErrorHandling(<function literal>[, options])` (type arguments
 * allowed), whose body's FIRST statement is exactly
 * `const <name> = await getUserCtx(<args>);` — one declaration, nothing
 * around the await. "Some await of getUserCtx somewhere inside the first
 * statement" accepted `const x = cond ? await getUserCtx(req) : null`, or
 * `await Promise.all([work(), getUserCtx(req)])`, or a handler that was never
 * wrapped at all (Phase 0.H review).
 */
export function isAccountHandlerShape(init: ts.Expression | null): boolean {
    if (!init || !ts.isCallExpression(init) || calleeName(init) !== 'withApiErrorHandling') return false;
    if (init.arguments.length < 1 || init.arguments.length > 2) return false;
    const fn = init.arguments[0];
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
    if (!ts.isBlock(fn.body)) return false;
    const first = fn.body.statements[0];
    if (!first || !ts.isVariableStatement(first)) return false;
    const list = first.declarationList;
    if (!isPlainConst(list.flags)) return false;
    if (list.declarations.length !== 1) return false;
    const [d] = list.declarations;
    if (!ts.isIdentifier(d.name) || !d.initializer || !ts.isAwaitExpression(d.initializer)) return false;
    const call = d.initializer.expression;
    return ts.isCallExpression(call) && calleeName(call) === 'getUserCtx';
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
