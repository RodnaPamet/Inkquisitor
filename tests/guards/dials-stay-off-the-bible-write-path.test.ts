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

/** Every import specifier of a file, type-only ones included. */
function allSpecifiers(file: string): string[] {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    sf.forEachChild((n) => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    });
    return out;
}

function resolves(spec: string, from: string): string | null {
    const base = spec.startsWith('@/') ? path.join(REPO_ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
    if (!base) return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    return null;
}

/** The modules that write the bible through the seam: they import one of its writers. */
function writePathRoots(): string[] {
    const roots = [SEAM];
    for (const file of repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })) {
        if (file === SEAM) continue;
        const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        sf.forEachChild((n) => {
            if (!ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier) || resolves(n.moduleSpecifier.text, file) !== SEAM) return;
            const named = n.importClause?.namedBindings;
            if (named && ts.isNamedImports(named) && named.elements.some((e) => WRITERS.includes((e.propertyName ?? e.name).text))) roots.push(file);
        });
    }
    return roots;
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

it('no write-path module imports a dial or pack module, not even for its types', () => {
    const reach = reachFrom(roots);
    const offenders: string[] = [];
    for (const file of reach.reached.keys()) {
        if (!file.startsWith(path.join(REPO_ROOT, 'src'))) continue;
        for (const spec of allSpecifiers(file)) {
            const target = resolves(spec, file);
            if (target && DIAL_MODULES.includes(repoRelative(target))) offenders.push(`${repoRelative(file)} → ${spec}`);
        }
    }
    expect(offenders).toEqual([]);
});

it('the check sees a planted import (negative control)', () => {
    // A module importing the dials, walked as a root, is caught by both rules.
    const fixture = path.join(REPO_ROOT, 'src/lib/interview/plan.ts'); // imports ./dials
    const reach = reachFrom([fixture]);
    expect([...reach.reached.keys()].map(repoRelative)).toContain('src/lib/interview/dials.ts');
    expect(allSpecifiers(fixture).map((s) => resolves(s, fixture)).filter(Boolean).map((t) => repoRelative(t!))).toContain('src/lib/interview/dials.ts');
});
