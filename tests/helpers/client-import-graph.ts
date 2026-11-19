/**
 * THE IMPORT GRAPH `next build` BUNDLES FROM A ROOT — one definition.
 *
 * Two guards ask what a module can reach:
 *
 *   - `client-reachable-modules-import-no-server-env` — `src/env.ts` reached
 *     from a `'use client'` file ships the server schema in First Load JS.
 *   - `proxy-imports-no-node-only-module` — the proxy's graph stays free of
 *     Node-only modules (issue #8).
 *
 * They must agree about what an EDGE is, because a disagreement is silent in
 * the direction that matters: a walker that misses an edge reports "not
 * reachable" about a module webpack bundles anyway.
 *
 * WHAT COUNTS AS AN EDGE. Value imports, re-exports, `import()` and `require()`
 * with a literal specifier — every one bundles the target. `import type` and
 * all-`type` specifier lists are erased at compile time and are not edges.
 * `@/` and `@inkquisitor/ui/` resolve to source; any other bare specifier is a
 * package and is not walked (it is reported in `unresolved` for the caller to
 * judge).
 *
 * Lifted from inflect-compliance's `tests/helpers/client-import-graph.ts` (see
 * docs/carve-manifest.md); its walked-package support is not carried.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

import { REPO_ROOT, repoFiles, repoRelative } from './repo-files';
import { codeOf } from './source-blocks';

export const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** The source file a specifier names, or null for a package (not walked). */
export function resolveSpecifier(spec: string, fromFile: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = path.join(REPO_ROOT, 'src', spec.slice(2));
    else if (spec.startsWith('@inkquisitor/ui/')) base = path.join(REPO_ROOT, 'packages/ui/src', spec.slice('@inkquisitor/ui/'.length));
    else if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(fromFile), spec);
    else return null;
    const candidates = [
        base,
        ...EXTENSIONS.map((e) => base + e),
        ...EXTENSIONS.map((e) => path.join(base, `index${e}`)),
    ];
    return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

/** Every specifier a module bundles: value imports, re-exports, import(), require(). */
export function bundledSpecifiers(source: string, fileName = 'x.ts'): string[] {
    const sf = ts.createSourceFile(
        fileName, source, ts.ScriptTarget.Latest, true,
        fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
            const clause = n.importClause;
            const typeOnly = !!clause && (clause.isTypeOnly || (
                !clause.name
                && !!clause.namedBindings
                && ts.isNamedImports(clause.namedBindings)
                && clause.namedBindings.elements.length > 0
                && clause.namedBindings.elements.every((e) => e.isTypeOnly)
            ));
            if (!typeOnly) out.push(n.moduleSpecifier.text);
        } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
            const typeOnly = n.isTypeOnly || (
                !!n.exportClause
                && ts.isNamedExports(n.exportClause)
                && n.exportClause.elements.length > 0
                && n.exportClause.elements.every((e) => e.isTypeOnly)
            );
            if (!typeOnly) out.push(n.moduleSpecifier.text);
        } else if (
            ts.isCallExpression(n)
            && n.arguments.length === 1
            && ts.isStringLiteralLike(n.arguments[0])
            && (n.expression.kind === ts.SyntaxKind.ImportKeyword
                || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
        ) {
            out.push(n.arguments[0].text);
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

const specifierCache = new Map<string, string[]>();
export function specifiersOf(file: string): string[] {
    let s = specifierCache.get(file);
    if (!s) {
        s = bundledSpecifiers(fs.readFileSync(file, 'utf8'), file);
        specifierCache.set(file, s);
    }
    return s;
}

/** The directive must be the first statement; comments may precede it. */
export function isClientModule(source: string): boolean {
    // Comments blanked by codeOf (#4659), so trimStart skips them.
    const head = codeOf(source.replace(/^﻿/, ''));
    return /^['"]use client['"]/.test(head.trimStart());
}

/** Every `'use client'` file under `src/`, the roots of the client graph. */
export function clientRoots(): string[] {
    return repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })
        .filter((f) => isClientModule(fs.readFileSync(f, 'utf8')));
}

export interface Reach {
    /** Every source module reached, mapped to the module that first reached it. */
    readonly reached: ReadonlyMap<string, string | null>;
    /**
     * Every specifier that resolved to no source file, with the module that
     * imported it — packages and Node built-ins both land here. The CALLER
     * classifies: this walk has no opinion about which are allowed.
     */
    readonly unresolved: ReadonlyArray<{ readonly module: string; readonly spec: string }>;
    /** `a → b → c`, repo-relative, from a root to `file`. */
    via(file: string): string;
}

/** Breadth-first over the bundled-import graph from `roots`. */
export function reachFrom(roots: readonly string[]): Reach {
    const reached = new Map<string, string | null>();
    const queue: string[] = [];
    for (const r of roots) {
        if (!reached.has(r)) {
            reached.set(r, null);
            queue.push(r);
        }
    }
    const unresolved: Array<{ module: string; spec: string }> = [];
    for (let i = 0; i < queue.length; i++) {
        const file = queue[i];
        for (const spec of specifiersOf(file)) {
            const target = resolveSpecifier(spec, file);
            if (target === null) {
                unresolved.push({ module: file, spec });
                continue;
            }
            if (!reached.has(target)) {
                reached.set(target, file);
                queue.push(target);
            }
        }
    }
    const via = (file: string): string => {
        const chain: string[] = [];
        for (let f: string | null | undefined = file; f; f = reached.get(f)) chain.unshift(repoRelative(f));
        return chain.join(' → ');
    };
    return { reached, unresolved, via };
}
