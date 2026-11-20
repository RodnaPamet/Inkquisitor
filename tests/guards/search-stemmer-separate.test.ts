/**
 * Word search's stemmer and the question engine's stay apart (Phase 3.4,
 * decision D21). Grounding (`grounded`) and deduplication depend on the
 * light stemmer `stem()` in `src/lib/interview/text.ts` and must never move
 * because search was tuned; search uses Porter2 (`src/lib/search/`) and must
 * never fall back on the light one. So no search module imports the
 * interview text module, and no module that reaches grounding or
 * deduplication imports a search module.
 *
 * The population is every source file git knows (`repoFiles`), read for its
 * import specifiers with the TypeScript parser (static imports, re-exports,
 * `import()` and `require()`), so a comment or a string that merely names a
 * path does not count, and a new file is covered the moment it exists.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

/** The module specifiers a source imports. Pure, for the negative controls. */
export function importSpecifiers(file: string, source: string): string[] {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
        if (ts.isCallExpression(n) && n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0])) {
            if (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) out.push(n.arguments[0].text);
        }
        n.forEachChild(visit);
    };
    visit(sf);
    return out;
}

/** A specifier resolved to a repo-relative path without extension (only `@/` and relative ones; packages stay as written). */
export function resolveSpecifier(from: string, spec: string): string {
    if (spec.startsWith('@/')) return path.posix.join('src', spec.slice(2));
    if (spec.startsWith('.')) return path.posix.join(path.posix.dirname(from), spec);
    return spec;
}

const isSearchModule = (p: string) => p === 'src/lib/search' || p.startsWith('src/lib/search/');
const LIGHT_STEMMER = 'src/lib/interview/text';
/** The modules grounding and deduplication live in: they keep the light stemmer, and never reach search. */
const GROUNDING_MODULES = ['src/lib/interview/text', 'src/lib/interview/candidates', 'src/lib/interview/dedupe', 'src/lib/enrichment/validate', 'src/lib/research/validate', 'src/lib/research/sources'];

const files = repoRelativeFiles().filter((f) => /^(src|scripts)\/.*\.(ts|tsx)$/.test(f));
const importsOf = (f: string) => importSpecifiers(f, fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')).map((s) => resolveSpecifier(f, s).replace(/\.(ts|tsx)$/, ''));

it('reads the search modules and the grounding modules (none found would pass vacuously)', () => {
    expect(files.filter((f) => isSearchModule(f)).length).toBeGreaterThanOrEqual(5);
    for (const m of GROUNDING_MODULES) expect(files).toContain(`${m}.ts`);
});

it('no search module imports the question engine’s light stemmer', () => {
    const offenders = files.filter((f) => isSearchModule(f)).filter((f) => importsOf(f).includes(LIGHT_STEMMER));
    expect(offenders).toEqual([]);
});

it('no grounding or deduplication module imports a search module', () => {
    const offenders = GROUNDING_MODULES.map((m) => `${m}.ts`).filter((f) => importsOf(f).some(isSearchModule));
    expect(offenders).toEqual([]);
});

it('the light stemmer is still the one grounding uses (a guard over a moved function would check nothing)', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, `${LIGHT_STEMMER}.ts`), 'utf8');
    expect(text).toMatch(/^export function stem\(word: string\): string \{$/m);
});

describe('negative controls', () => {
    it('finds static imports, re-exports, import() and require(), and not a path named in a comment', () => {
        const src = [
            "import { stem } from '@/lib/interview/text';",
            "export { porter2Stem } from '@/lib/search/porter2';",
            "const m = await import('./rank');",
            "const r = require('../search/query');",
            "// import nothing from '@/lib/search/analyse'",
        ].join('\n');
        expect(importSpecifiers('src/lib/search/x.ts', src).map((s) => resolveSpecifier('src/lib/search/x.ts', s))).toEqual([
            'src/lib/interview/text',
            'src/lib/search/porter2',
            'src/lib/search/rank',
            'src/lib/search/query',
        ]);
    });
});
