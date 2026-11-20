/**
 * A DIAL CHANGES PROMPTS AND BUDGETS ONLY; IT NEVER CHANGES WHAT MAY BE
 * WRITTEN TO THE BIBLE (roadmap 2.3) — held by structure, not by care.
 *
 * The bible is written in one place: the versioned save in
 * `src/app-layer/usecases/bible-common.ts` (`writeFieldValues`, then
 * `recordVersion`, under the element's lock). Every module that calls it —
 * the bible's own usecases today, 2.5's acceptance of interview proposals
 * tomorrow — is a ROOT of the write path, and so is the seam itself.
 *
 *   1. Nothing a root reaches through its imports (value edges, as the
 *      bundler sees them) is a dial or pack module: the dial tables, the dial
 *      settings and their precedence, the defaults, the packs, the mount gate.
 *   2. No root imports one even for its TYPES: a write-path signature that
 *      named `Dials`, `DialSettings` or a pack would let a dial choose what is
 *      written, whatever its body does today.
 *
 * So a dial can shape how a question is asked and how much a session spends,
 * and cannot reach the code that decides what is stored. A new write-path
 * module that wants a dial fails here, by name.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { reachFrom } from '../helpers/client-import-graph';
import { REPO_ROOT, repoFiles, repoRelative } from '../helpers/repo-files';

const SEAM = path.join(REPO_ROOT, 'src/app-layer/usecases/bible-common.ts');
const WRITERS = ['writeFieldValues', 'recordVersion'];

/** The dial and pack modules, repo-relative. */
const DIAL_MODULES = [
    'src/lib/interview/dials.ts',
    'src/lib/interview/dial-settings.ts',
    'src/lib/interview/packs.ts',
    'src/lib/interview/pack-mount.ts',
    'src/lib/interview/pack-evaluation.ts',
    'src/lib/interview/pack-records-config.ts',
    'src/app-layer/usecases/interview-defaults.ts',
    'src/app-layer/usecases/interview-packs.ts',
    'src/app-layer/repositories/interview-defaults.repository.ts',
];

/** Source held in memory by the negative controls, by absolute path: never written into the tree other guards scan. */
type Overlay = ReadonlyMap<string, string>;
const NO_OVERLAY: Overlay = new Map();

function sourceOf(file: string, overlay: Overlay): string {
    return overlay.get(file) ?? fs.readFileSync(file, 'utf8');
}

/** Every import specifier of a file, type-only ones included: imports, re-exports, `import()`, `require()` and `import('…')` types. */
function allSpecifiers(file: string, overlay: Overlay = NO_OVERLAY): string[] {
    const sf = ts.createSourceFile(file, sourceOf(file, overlay), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
        else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) out.push(n.moduleReference.expression.text);
        else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) out.push(n.argument.literal.text);
        else if (
            ts.isCallExpression(n) &&
            n.arguments.length >= 1 &&
            ts.isStringLiteralLike(n.arguments[0]) &&
            (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
        ) {
            out.push(n.arguments[0].text);
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

function resolves(spec: string, from: string, overlay: Overlay = NO_OVERLAY): string | null {
    const base = spec.startsWith('@/') ? path.join(REPO_ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
    if (!base) return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) if (overlay.has(c) || (fs.existsSync(c) && fs.statSync(c).isFile())) return c;
    return null;
}

/**
 * Does `file` take one of the seam's writers? A named import or re-export of
 * one; and, because the binding cannot be read off the declaration, a
 * namespace import, a default import, an `export *`, an `import = require` or
 * a dynamic `import()` / `require()` of the seam at all. A named import of
 * other helpers only (`requireBook`) is not a writer.
 */
function takesAWriter(file: string, overlay: Overlay = NO_OVERLAY): boolean {
    const seam = SEAM;
    const sf = ts.createSourceFile(file, sourceOf(file, overlay), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const isSeam = (spec: ts.Expression | undefined): boolean => !!spec && ts.isStringLiteralLike(spec) && resolves(spec.text, file) === seam;
    let found = false;
    const visit = (n: ts.Node): void => {
        if (found) return;
        if (ts.isImportDeclaration(n) && isSeam(n.moduleSpecifier)) {
            const clause = n.importClause;
            if (clause && !clause.isTypeOnly) {
                if (clause.name) found = true;
                const named = clause.namedBindings;
                if (named && ts.isNamespaceImport(named)) found = true;
                if (named && ts.isNamedImports(named) && named.elements.some((e) => !e.isTypeOnly && WRITERS.includes((e.propertyName ?? e.name).text))) found = true;
            }
        } else if (ts.isExportDeclaration(n) && isSeam(n.moduleSpecifier) && !n.isTypeOnly) {
            const clause = n.exportClause;
            if (!clause || ts.isNamespaceExport(clause)) found = true;
            else if (clause.elements.some((e) => !e.isTypeOnly && WRITERS.includes((e.propertyName ?? e.name).text))) found = true;
        } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && isSeam(n.moduleReference.expression)) {
            found = true;
        } else if (
            ts.isCallExpression(n) &&
            n.arguments.length >= 1 &&
            isSeam(n.arguments[0]) &&
            (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
        ) {
            found = true;
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
}

/** The modules that write the bible through the seam: they take one of its writers. */
function writePathRoots(): string[] {
    const roots = [SEAM];
    for (const file of repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })) {
        if (file !== SEAM && takesAWriter(file)) roots.push(file);
    }
    return roots;
}

/** Every source module `roots` reach through ANY import, type-only ones included, mapped to the module that reached it. */
function typeAndValueReach(start: readonly string[], overlay: Overlay = NO_OVERLAY): Map<string, string | null> {
    const reached = new Map<string, string | null>(start.map((r) => [r, null] as const));
    const queue = [...start];
    for (let i = 0; i < queue.length; i++) {
        for (const spec of allSpecifiers(queue[i], overlay)) {
            const target = resolves(spec, queue[i], overlay);
            if (target && !reached.has(target)) {
                reached.set(target, queue[i]);
                queue.push(target);
            }
        }
    }
    return reached;
}

function chainTo(reached: ReadonlyMap<string, string | null>, file: string): string {
    const chain: string[] = [];
    for (let f: string | null | undefined = file; f; f = reached.get(f)) chain.unshift(repoRelative(f));
    return chain.join(' → ');
}

const roots = writePathRoots();

it('finds the write path: the seam and the bible usecases that write through it', () => {
    const rel = roots.map(repoRelative);
    expect(rel).toEqual(expect.arrayContaining(['src/app-layer/usecases/bible-common.ts', 'src/app-layer/usecases/bible-elements.ts', 'src/app-layer/usecases/bible-versions.ts', 'src/app-layer/usecases/bible-import.ts']));
    for (const m of DIAL_MODULES) expect(fs.existsSync(path.join(REPO_ROOT, m))).toBe(true);
});

it('no module on the write path reaches a dial or pack module', () => {
    const reach = reachFrom(roots);
    const hits = [...reach.reached.keys()].map(repoRelative).filter((f) => DIAL_MODULES.includes(f));
    expect(hits.map((h) => reach.via(path.join(REPO_ROOT, h)))).toEqual([]);
});

it('no write-path module imports a dial or pack module, not even for its types, however far down', () => {
    // Type-only edges are walked too: a write-path signature naming a type
    // that is itself built from `Dials` would let a dial shape what is written.
    const reached = typeAndValueReach(roots);
    const hits = [...reached.keys()].filter((f) => DIAL_MODULES.includes(repoRelative(f)));
    expect(hits.map((h) => chainTo(reached, h))).toEqual([]);
});

describe('the check sees a planted import (negative controls)', () => {
    const overlay = new Map<string, string>();
    /** A module beside the seam, held in memory only (another guard scanning the tree never sees it). */
    function plant(name: string, source: string): string {
        const file = path.join(path.dirname(SEAM), `${name}.ts`);
        overlay.set(file, source);
        return file;
    }

    it('a module importing the dials is reached, by value and by specifier', () => {
        const fixture = path.join(REPO_ROOT, 'src/lib/interview/plan.ts'); // imports ./dials
        const reach = reachFrom([fixture]);
        expect([...reach.reached.keys()].map(repoRelative)).toContain('src/lib/interview/dials.ts');
        expect(allSpecifiers(fixture).map((s) => resolves(s, fixture)).filter(Boolean).map((t) => repoRelative(t!))).toContain('src/lib/interview/dials.ts');
    });

    it('a writer taken by name, by namespace, by default, by re-export or by dynamic import makes a root; a helper alone does not', () => {
        const cases: Array<[string, string, boolean]> = [
            ['zz-guard-named', "import { writeFieldValues } from './bible-common';\nexport const x = writeFieldValues;\n", true],
            ['zz-guard-aliased', "import { recordVersion as rv } from './bible-common';\nexport const x = rv;\n", true],
            ['zz-guard-namespace', "import * as common from './bible-common';\nexport const x = common.writeFieldValues;\n", true],
            ['zz-guard-reexport', "export { writeFieldValues } from './bible-common';\n", true],
            ['zz-guard-star', "export * from './bible-common';\n", true],
            ['zz-guard-dynamic', "export const x = () => import('./bible-common');\n", true],
            ['zz-guard-helper', "import { requireBook } from './bible-common';\nexport const x = requireBook;\n", false],
            ['zz-guard-type', "import type { recordVersion } from './bible-common';\nexport type X = typeof recordVersion;\n", false],
        ];
        for (const [name, source, expected] of cases) expect([name, takesAWriter(plant(name, source), overlay)]).toEqual([name, expected]);
    });

    it('a dial reached only through type-only imports, two modules down, is found', () => {
        const types = plant('zz-guard-dial-types', "import type { Dials } from '@/lib/interview/dials';\nexport type Carried = Dials;\n");
        const root = plant('zz-guard-typed-root', "import type { Carried } from './zz-guard-dial-types';\nimport * as common from './bible-common';\nexport const x = (c: Carried) => [c, common.recordVersion];\n");
        expect(takesAWriter(root, overlay)).toBe(true);
        const reached = typeAndValueReach([root], overlay);
        expect(reached.has(types)).toBe(true);
        expect([...reached.keys()].map(repoRelative)).toContain('src/lib/interview/dials.ts');
    });
});
