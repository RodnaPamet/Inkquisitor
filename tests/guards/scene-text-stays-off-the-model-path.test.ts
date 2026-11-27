/**
 * D3: NO MODEL OUTPUT IS EVER WRITTEN TO A SCENE'S TEXT (Phase 5.1) — held by
 * structure, not by care.
 *
 * A scene's text column (and a version of it) is written by ONE module, the
 * scene text writer `src/app-layer/usecases/manuscript-text.ts`:
 *
 *   1. the repository methods that write the text — `ManuscriptSceneRepository`
 *      `.setText` / `.createScenes`, `SceneVersionRepository.create` /
 *      `.createMany` — are reached from that module and nowhere else: outside
 *      the writer and the repository, the two repository objects are used
 *      ONLY as `Object.readMethod` (never aliased, destructured, indexed,
 *      passed as a value or re-exported, so no alias can carry a text method
 *      past the check); inside the repository only those methods put `text`
 *      in a write's `data`; no other file writes the scene or version table
 *      through Prisma, directly or as a NESTED write through a relation
 *      (`chapter.update({ data: { scenes: { update … } } })`); and no raw
 *      SQL anywhere in src inserts a scene or a version, writes a version, or
 *      sets a scene's text;
 *   2. the writer's functions are taken only by the modules listed here (the
 *      scene usecases: autosave, checkpoint, restore; the import), by name —
 *      and THEIR text-writing usecases (`saveSceneText`, `checkpointScene`,
 *      `restoreSceneVersion`, `confirmManuscriptImport`) only by their own
 *      route handlers, the HTTP boundary where the author's request arrives,
 *      so no model-path module can call a text-writing usecase either;
 *   3. NOTHING on that write path — the writer, its callers, and everything
 *      they reach through their imports, as the bundler sees them — reaches the
 *      model layer: the SDK's one file, `callStructured`, the server-tool loop,
 *      the model stub, the model-calls usecase, or any feature's model seam;
 *   4. and the research acceptance, which writes a finding to a scene's NOTE
 *      (`manuscript-notes.ts`), reaches neither the text writer nor its methods;
 *   5. and the PROSE CHECKS (Phase 5.2, D34) — the engine and its rules, the
 *      job, the reads, the scheduler, the editor's notes and suggestion mark —
 *      reach no model module and neither the text writer nor a text method:
 *      a note is computed by code and a suggestion is applied only by the
 *      author, in the editor, through its autosave.
 *
 * So a model can shape what is asked, proposed or noted, and cannot reach the
 * code that stores a scene's prose. A new caller of the writer fails here by
 * name; a new import that brings the model layer onto the path fails with the
 * chain that brought it. The checker is proved against planted sources below.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { reachFrom } from '../helpers/client-import-graph';
import { REPO_ROOT, repoFiles, repoRelative } from '../helpers/repo-files';

const SEAM = 'src/app-layer/usecases/manuscript-text.ts';
const SEAM_WRITERS = ['writeSceneText', 'checkpointSceneText', 'restoreSceneText', 'createImportedScenes'];
/** The modules allowed to take a writer: the scene usecases and the import. */
const ALLOWED_CALLERS = ['src/app-layer/usecases/manuscript-scenes.ts', 'src/app-layer/usecases/manuscript-import.ts'];
const REPOSITORY = 'src/app-layer/repositories/manuscript.repository.ts';
/** The text-writing methods, by the repository object that holds them. */
const TEXT_METHODS: ReadonlyArray<[string, string]> = [
    ['ManuscriptSceneRepository', 'setText'],
    ['ManuscriptSceneRepository', 'createScenes'],
    ['SceneVersionRepository', 'create'],
    ['SceneVersionRepository', 'createMany'],
];
/** The research acceptance and the note writer: they write a scene's NOTE, never its text. */
const NOTE_PATH = ['src/app-layer/usecases/research-review.ts', 'src/app-layer/usecases/manuscript-notes.ts'];
/** The callers' text-writing usecases, and the only modules allowed to take each (the route handlers: the author's request). */
const ROUTES = 'src/app/api/w/[workspaceSlug]/books/[bookId]/manuscript';
const TEXT_USECASES: ReadonlyArray<{ module: string; names: readonly string[]; takers: readonly string[] }> = [
    {
        module: 'src/app-layer/usecases/manuscript-scenes.ts',
        names: ['saveSceneText', 'checkpointScene', 'restoreSceneVersion'],
        takers: [`${ROUTES}/scenes/[sceneId]/text/route.ts`, `${ROUTES}/scenes/[sceneId]/checkpoint/route.ts`, `${ROUTES}/scenes/[sceneId]/versions/[versionNumber]/restore/route.ts`],
    },
    { module: 'src/app-layer/usecases/manuscript-import.ts', names: ['confirmManuscriptImport'], takers: [`${ROUTES}/import/route.ts`] },
];
/** The relation fields that reach the scene or version table (a nested write through one writes it), read from the schema. */
function relationFieldsToTextTables(): string[] {
    const out = new Set<string>();
    for (const f of repoFiles({ under: 'prisma/schema', extensions: ['.prisma'] })) {
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
            const m = /^\s+(\w+)\s+(?:ManuscriptScene|SceneVersion)(?:\[\]|\?)?(?:\s|$)/.exec(line);
            if (m) out.add(m[1]);
        }
    }
    return [...out];
}
const NESTED_WRITE_KEYS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'connectOrCreate', 'set']);

/** The model layer, repo-relative: every module that loads the SDK, makes a call, or wires a feature to one. */
function modelModules(): string[] {
    const fixed = ['src/lib/ai/client.ts', 'src/lib/ai/call-structured.ts', 'src/lib/ai/server-tool-loop.ts', 'src/lib/ai/model-stub.ts', 'src/app-layer/usecases/model-calls.ts'];
    const seams = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })
        .map(repoRelative)
        .filter((f) => /(^|\/)(model-seam|[a-z-]+-seam)\.ts$/.test(f) && fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').includes('callStructured'));
    return [...new Set([...fixed, ...seams])];
}

const abs = (rel: string) => path.join(REPO_ROOT, rel);
const parse = (file: string, source: string) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Calls `Object.method(` in a source: the repository methods a file calls. */
export function callsOf(source: string, file = 'x.ts'): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)) {
            out.push([n.expression.expression.text, n.expression.name.text]);
        }
        ts.forEachChild(n, visit);
    };
    visit(parse(file, source));
    return out;
}

const REPOSITORY_OBJECTS = new Map<string, ReadonlySet<string>>([
    ['ManuscriptSceneRepository', new Set(['setText', 'createScenes'])],
    ['SceneVersionRepository', new Set(['create', 'createMany'])],
]);

/**
 * Every use of the two text-writing repository objects in a source that is
 * not `Object.method` with a method that does not write text: a text method
 * reached by any spelling, the object aliased, destructured, indexed, spread,
 * passed or re-exported, a namespace import of the repository used any other
 * way than `ns.Object.method`, a dynamic import of it. `isRepository` says
 * whether a specifier names the repository module.
 */
export function repositoryObjectMisuses(source: string, file: string, isRepository: (spec: string) => boolean): string[] {
    const out: string[] = [];
    const sf = parse(file, source);
    const locals = new Map<string, string>();
    const namespaces = new Set<string>();
    for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && isRepository(st.moduleSpecifier.text)) {
            const clause = st.importClause;
            if (!clause || clause.isTypeOnly) continue;
            if (clause.name) out.push('default import of the repository');
            const named = clause.namedBindings;
            if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
            if (named && ts.isNamedImports(named)) {
                for (const e of named.elements) {
                    const imported = (e.propertyName ?? e.name).text;
                    if (!e.isTypeOnly && REPOSITORY_OBJECTS.has(imported)) locals.set(e.name.text, imported);
                }
            }
        } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && isRepository(st.moduleSpecifier.text) && !st.isTypeOnly) {
            const clause = st.exportClause;
            if (!clause || ts.isNamespaceExport(clause) || clause.elements.some((e) => REPOSITORY_OBJECTS.has((e.propertyName ?? e.name).text))) out.push('re-export of the repository');
        }
    }
    /** A use of `obj` (the repository object, by its real name) at `node`: allowed only as `node.readMethod` called or read. */
    const judge = (node: ts.Expression, obj: string) => {
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
            if (REPOSITORY_OBJECTS.get(obj)!.has(parent.name.text)) out.push(`${obj}.${parent.name.text}`);
            return;
        }
        out.push(`${obj} used as a value`);
    };
    const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && !ts.isImportSpecifier(n.parent) && !ts.isNamespaceImport(n.parent)) {
            const obj = locals.get(n.text);
            // `x.ManuscriptSceneRepository` is a property NAME, not the import (judged below through the namespace).
            const isName = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n;
            if (obj && !isName) judge(n, obj);
            if (namespaces.has(n.text) && !isName) {
                const parent = n.parent;
                if (ts.isPropertyAccessExpression(parent) && parent.expression === n) {
                    if (REPOSITORY_OBJECTS.has(parent.name.text)) judge(parent, parent.name.text);
                } else {
                    out.push('the repository namespace used as a value');
                }
            }
        }
        if (ts.isCallExpression(n) && n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0]) && isRepository(n.arguments[0].text) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
            out.push('dynamic import of the repository');
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

/** Inside the repository: the methods (`Object.method`) that put `text` in a write's `data` (directly or by shorthand). */
export function methodsWritingText(source: string, file = 'repo.ts'): string[] {
    const out = new Set<string>();
    const sf = parse(file, source);
    const enclosing = (n: ts.Node): string => {
        let method = '?';
        for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
            if ((ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p)) && method === '?' && ts.isIdentifier(p.name) && (ts.isMethodDeclaration(p) || ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) method = p.name.text;
            if (ts.isFunctionDeclaration(p) && p.name && method === '?') method = p.name.text;
            if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return `${p.name.text}.${method}`;
        }
        return `?.${method}`;
    };
    const insideData = (n: ts.Node): boolean => {
        for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'data') return true;
            // A callback inside the data (`rows.map((r) => ({ text: r.text }))`) is still the data; a method is the edge.
            if (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) return false;
        }
        return false;
    };
    const visit = (n: ts.Node): void => {
        const named = (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isIdentifier(n.name) && n.name.text === 'text';
        if (named && insideData(n)) out.add(enclosing(n));
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return [...out].sort();
}

/** Nested writes through a relation field that reaches the scene or version table: `{ <field>: { create | update | … } }`. */
export function nestedTextTableWrites(source: string, file: string, fields: ReadonlySet<string>): string[] {
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
        if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && fields.has(n.name.text) && ts.isObjectLiteralExpression(n.initializer)) {
            for (const p of n.initializer.properties) {
                const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
                if (key && NESTED_WRITE_KEYS.has(key)) out.push(`${n.name.text}.${key}`);
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(parse(file, source));
    return out;
}

/** Raw SQL that inserts a scene or a version, writes a version, or sets a scene's text (`MERGE`, `COPY` and a schema prefix included). */
export function rawTextTableWrites(source: string): string[] {
    const out: string[] = [];
    const table = String.raw`(?:"?public"?\s*\.\s*)?"(ManuscriptScene|SceneVersion)"`;
    for (const m of source.matchAll(new RegExp(String.raw`\b(INSERT\s+INTO|MERGE\s+INTO|COPY)\s+${table}`, 'gi'))) out.push(`${m[1]} ${m[2]}`);
    for (const m of source.matchAll(new RegExp(String.raw`\bUPDATE\s+${table}([^;\`]{0,400})`, 'gi'))) {
        // A version is never updated; a scene's UPDATE may set its rank or details, never its text.
        if (m[1] === 'SceneVersion' || /"text"\s*=/i.test(m[2])) out.push(`UPDATE ${m[1]}`);
    }
    return out;
}

/** Does a source take one of the seam's writers (by name, a namespace, a default, a re-export, a dynamic import)? */
export function takesAWriter(source: string, file: string, isSeam: (spec: string) => boolean, names: readonly string[] = SEAM_WRITERS): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
        if (found) return;
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && isSeam(n.moduleSpecifier.text)) {
            const clause = n.importClause;
            if (clause && !clause.isTypeOnly) {
                if (clause.name) found = true;
                const named = clause.namedBindings;
                if (named && ts.isNamespaceImport(named)) found = true;
                if (named && ts.isNamedImports(named) && named.elements.some((e) => !e.isTypeOnly && names.includes((e.propertyName ?? e.name).text))) found = true;
            }
        } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && isSeam(n.moduleSpecifier.text) && !n.isTypeOnly) {
            const clause = n.exportClause;
            if (!clause || ts.isNamespaceExport(clause) || clause.elements.some((e) => names.includes((e.propertyName ?? e.name).text))) found = true;
        } else if (
            ts.isCallExpression(n) &&
            n.arguments.length >= 1 &&
            ts.isStringLiteralLike(n.arguments[0]) &&
            isSeam(n.arguments[0].text) &&
            (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
        ) {
            found = true;
        }
        ts.forEachChild(n, visit);
    };
    visit(parse(file, source));
    return found;
}

function resolvesTo(target: string) {
    return (spec: string, from: string): boolean => {
        const base = spec.startsWith('@/') ? path.join(REPO_ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
        return base !== null && [base, `${base}.ts`, path.join(base, 'index.ts')].includes(abs(target));
    };
}
const resolvesToSeam = resolvesTo(SEAM);
const resolvesToRepository = resolvesTo(REPOSITORY);

const sources = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).map((f) => ({ file: f, rel: repoRelative(f), source: fs.readFileSync(f, 'utf8') }));

describe('the scene text column has one writer', () => {
    it('finds the writer, its methods and its callers (a guard that found none would pass vacuously)', () => {
        expect(fs.existsSync(abs(SEAM))).toBe(true);
        const repo = fs.readFileSync(abs(REPOSITORY), 'utf8');
        for (const [, method] of TEXT_METHODS) expect(repo).toContain(`async ${method}(`);
        for (const c of ALLOWED_CALLERS) expect(fs.existsSync(abs(c))).toBe(true);
        expect(modelModules().length).toBeGreaterThanOrEqual(10);
    });

    it('reaches the text-writing repository methods only from the writer, by no alias, and uses the objects no other way', () => {
        const hits = sources
            .filter((s) => s.rel !== SEAM && s.rel !== REPOSITORY)
            .flatMap((s) => repositoryObjectMisuses(s.source, s.file, (spec) => resolvesToRepository(spec, s.file)).map((m) => `${s.rel}: ${m}`));
        expect(hits).toEqual([]);
        // And the writer itself does reach them (the check is not vacuous).
        const seam = sources.find((s) => s.rel === SEAM)!;
        expect(new Set(repositoryObjectMisuses(seam.source, seam.file, (spec) => resolvesToRepository(spec, seam.file)))).toEqual(
            new Set(['ManuscriptSceneRepository.createScenes', 'ManuscriptSceneRepository.setText', 'SceneVersionRepository.create', 'SceneVersionRepository.createMany']),
        );
    });

    it('inside the repository, only the text methods put `text` in a write', () => {
        const repo = sources.find((s) => s.rel === REPOSITORY)!;
        expect(methodsWritingText(repo.source, repo.file)).toEqual(['ManuscriptSceneRepository.createScenes', 'ManuscriptSceneRepository.setText', 'SceneVersionRepository.create', 'SceneVersionRepository.createMany'].sort());
    });

    it('writes the scene and version tables through Prisma only in the repository, by no nested write, and by no raw SQL', () => {
        const delegate = /\.(manuscriptScene|sceneVersion)\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert)\s*\(/;
        expect(sources.filter((s) => s.rel !== REPOSITORY && delegate.test(s.source)).map((s) => s.rel)).toEqual([]);
        const fields = new Set(relationFieldsToTextTables());
        expect([...fields].sort()).toEqual(expect.arrayContaining(['scene', 'scenes', 'scenesAsPov', 'scenesAsSetting', 'sceneVersions']));
        expect(sources.flatMap((s) => nestedTextTableWrites(s.source, s.file, fields).map((w) => `${s.rel}: ${w}`))).toEqual([]);
        expect(sources.flatMap((s) => rawTextTableWrites(s.source).map((w) => `${s.rel}: ${w}`))).toEqual([]);
    });

    it('lets only their route handlers take the callers\' text-writing usecases', () => {
        for (const u of TEXT_USECASES) {
            const isModule = resolvesTo(u.module);
            const takers = sources.filter((s) => s.rel !== u.module && takesAWriter(s.source, s.file, (spec) => isModule(spec, s.file), u.names)).map((s) => s.rel);
            expect(takers.sort()).toEqual([...u.takers].sort());
        }
    });

    it('lets only the listed modules take the writer', () => {
        const takers = sources.filter((s) => s.rel !== SEAM && takesAWriter(s.source, s.file, (spec) => resolvesToSeam(spec, s.file))).map((s) => s.rel);
        expect(takers.sort()).toEqual([...ALLOWED_CALLERS].sort());
    });
});

describe('the text write path never reaches the model layer', () => {
    const models = new Set(modelModules());

    it('no module the writer or its callers reach is a model module', () => {
        const reach = reachFrom([SEAM, ...ALLOWED_CALLERS].map(abs));
        const hits = [...reach.reached.keys()].filter((f) => models.has(repoRelative(f)));
        expect(hits.map((h) => reach.via(h))).toEqual([]);
    });

    it('the research acceptance and the note writer reach neither the text writer nor a text method', () => {
        const reach = reachFrom(NOTE_PATH.map(abs));
        expect([...reach.reached.keys()].map(repoRelative)).not.toContain(SEAM);
        const callers = [...reach.reached.keys()].filter((f) => repoRelative(f) !== REPOSITORY && callsOf(fs.readFileSync(f, 'utf8'), f).some(([obj, m]) => TEXT_METHODS.some(([o, mm]) => o === obj && mm === m)));
        expect(callers.map(repoRelative)).toEqual([]);
    });
});

/** The prose checks (5.2, D34): every module of the feature, by directory and by name. */
function proseCheckModules(): string[] {
    const named = [
        'src/app-layer/usecases/prose-check-run.ts',
        'src/app-layer/usecases/prose-check-setup.ts',
        'src/app-layer/usecases/prose-check-schedule.ts',
        'src/app-layer/usecases/prose-checks.ts',
        'src/app-layer/repositories/prose-check.repository.ts',
        'src/components/manuscript/ProseNotesMargin.tsx',
        'src/components/manuscript/ProseCheckSettings.tsx',
        'src/components/manuscript/prose-notes-extension.ts',
        'src/components/manuscript/use-prose-notes.ts',
    ];
    const lib = repoFiles({ under: 'src/lib/prose-checks', extensions: ['.ts', '.tsx'] }).map(repoRelative);
    return [...lib, ...named];
}

describe('the prose checks never reach the model layer or the text writer (D3, D34)', () => {
    const models = new Set(modelModules());
    const modules = proseCheckModules();

    it('finds the feature (a guard that found none would pass vacuously)', () => {
        expect(modules.filter((m) => m.startsWith('src/lib/prose-checks/')).length).toBeGreaterThanOrEqual(10);
        for (const m of modules) expect(fs.existsSync(abs(m))).toBe(true);
    });

    it('no module the prose checks reach is a model module', () => {
        const reach = reachFrom(modules.map(abs));
        const hits = [...reach.reached.keys()].filter((f) => models.has(repoRelative(f)));
        expect(hits.map((h) => reach.via(h))).toEqual([]);
    });

    it('the prose checks reach neither the text writer nor a text-writing method', () => {
        const reach = reachFrom(modules.map(abs));
        expect([...reach.reached.keys()].map(repoRelative)).not.toContain(SEAM);
        const callers = [...reach.reached.keys()].filter((f) => repoRelative(f) !== REPOSITORY && callsOf(fs.readFileSync(f, 'utf8'), f).some(([obj, m]) => TEXT_METHODS.some(([o, mm]) => o === obj && mm === m)));
        expect(callers.map(repoRelative)).toEqual([]);
    });
});

describe('the checker sees what is planted (negative controls)', () => {
    const seamFrom = (file: string) => (spec: string) => resolvesToSeam(spec, file);
    const beside = abs('src/app-layer/usecases/zz-planted.ts');

    it('a writer taken by name, alias, namespace, re-export or dynamic import is a taker; a type alone is not', () => {
        const cases: Array<[string, boolean]> = [
            ["import { writeSceneText } from './manuscript-text';", true],
            ["import { restoreSceneText as r } from '@/app-layer/usecases/manuscript-text';", true],
            ["import * as text from './manuscript-text';", true],
            ["export { createImportedScenes } from './manuscript-text';", true],
            ["export const x = () => import('./manuscript-text');", true],
            ["import type { SceneTextResult } from './manuscript-text';", false],
            ["import { MENTION_LINKS_MAX } from './manuscript-text';", false],
        ];
        for (const [src, want] of cases) expect([src, takesAWriter(src, beside, seamFrom(beside))]).toEqual([src, want]);
    });

    it('a text method called from another file is seen', () => {
        expect(callsOf('await ManuscriptSceneRepository.setText(db, w, id, data);')).toContainEqual(['ManuscriptSceneRepository', 'setText']);
        expect(callsOf('await SceneVersionRepository.createMany(db, w, b, rows, a);')).toContainEqual(['SceneVersionRepository', 'createMany']);
    });

    it('a text method reached through an alias, a destructuring, an index, a namespace or a re-export is seen; a read is not', () => {
        const isRepo = (spec: string) => resolvesToRepository(spec, beside);
        const imp = "import { ManuscriptSceneRepository, SceneVersionRepository } from '@/app-layer/repositories/manuscript.repository';\n";
        const cases: Array<[string, boolean]> = [
            [`${imp}await ManuscriptSceneRepository.find(db, w, b, id);`, false],
            [`${imp}await SceneVersionRepository.latest(db, w, id);`, false],
            [`${imp}await ManuscriptSceneRepository.setText(db, w, id, d);`, true],
            [`${imp}const R = ManuscriptSceneRepository; await R.setText(db, w, id, d);`, true],
            [`${imp}const { setText } = ManuscriptSceneRepository;`, true],
            [`${imp}await ManuscriptSceneRepository['setText'](db, w, id, d);`, true],
            [`${imp}helper(SceneVersionRepository);`, true],
            ["import { ManuscriptSceneRepository as S } from '@/app-layer/repositories/manuscript.repository';\nawait S.createScenes(db, w, b, rows);", true],
            ["import * as repo from '@/app-layer/repositories/manuscript.repository';\nawait repo.SceneVersionRepository.create(db, w, d);", true],
            ["import * as repo from '@/app-layer/repositories/manuscript.repository';\nawait repo.ManuscriptSceneRepository.find(db, w, b, id);", false],
            ["import * as repo from '@/app-layer/repositories/manuscript.repository';\nuse(repo);", true],
            ["export { ManuscriptSceneRepository as Scenes } from '@/app-layer/repositories/manuscript.repository';", true],
            ["export * from '@/app-layer/repositories/manuscript.repository';", true],
            ["const m = await import('@/app-layer/repositories/manuscript.repository');", true],
            ["import { ManuscriptPartRepository } from '@/app-layer/repositories/manuscript.repository';\nawait ManuscriptPartRepository.create(db, w, d);", false],
        ];
        for (const [src, want] of cases) expect([src, repositoryObjectMisuses(src, beside, isRepo).length > 0]).toEqual([src, want]);
    });

    it('a repository method that puts `text` in a write is seen, as a read of it is not', () => {
        const repo = `export const ManuscriptSceneRepository = {
            async updateMeta(db, w, id, data) { return db.manuscriptScene.updateMany({ where: { id }, data: { title: data.title, text: data.text } }); },
            async find(db, w, id) { return db.manuscriptScene.findFirst({ where: { id }, select: { text: true } }); },
        };
        export const SceneVersionRepository = { async create(db, w, text) { return db.sceneVersion.create({ data: { text } }); } };`;
        expect(methodsWritingText(repo)).toEqual(['ManuscriptSceneRepository.updateMeta', 'SceneVersionRepository.create']);
    });

    it('a nested write through a relation to the scene or version table is seen', () => {
        const fields = new Set(['scenes', 'scene', 'sceneVersions']);
        expect(nestedTextTableWrites('db.manuscriptChapter.update({ where: { id }, data: { scenes: { updateMany: { where: {}, data: { text: t } } } } });', 'x.ts', fields)).toEqual(['scenes.updateMany']);
        expect(nestedTextTableWrites('db.researchProposal.update({ where: { id }, data: { scene: { update: { text: t } } } });', 'x.ts', fields)).toEqual(['scene.update']);
        expect(nestedTextTableWrites('db.book.update({ data: { sceneVersions: { create: [{ text: t }] } } });', 'x.ts', fields)).toEqual(['sceneVersions.create']);
        expect(nestedTextTableWrites('db.manuscriptChapter.findMany({ include: { scenes: { select: { id: true } } } });', 'x.ts', fields)).toEqual([]);
    });

    it('raw SQL inserting a scene or a version, writing a version, or setting a scene\'s text is seen; a rank update is not', () => {
        expect(rawTextTableWrites('db.$executeRaw`INSERT INTO "ManuscriptScene" ("id") VALUES (1)`')).toEqual(['INSERT INTO ManuscriptScene']);
        expect(rawTextTableWrites('db.$executeRaw`UPDATE public."ManuscriptScene" SET "title" = 1, "text" = ${t}`')).toEqual(['UPDATE ManuscriptScene']);
        expect(rawTextTableWrites('db.$executeRaw`update "SceneVersion" set "wordCount" = 1`')).toEqual(['UPDATE SceneVersion']);
        expect(rawTextTableWrites('db.$executeRaw`MERGE INTO "SceneVersion" AS v USING x ON true`')).toEqual(['MERGE INTO SceneVersion']);
        expect(rawTextTableWrites('db.$executeRaw`UPDATE "ManuscriptScene" AS t SET "rank" = v."rank" FROM unnest(${a}::text[]) AS v("id")`')).toEqual([]);
    });

    it('a text-writing usecase taken by a module that is not its route is seen', () => {
        const isScenes = (spec: string) => resolvesTo('src/app-layer/usecases/manuscript-scenes.ts')(spec, beside);
        const names = TEXT_USECASES[0].names;
        expect(takesAWriter("import { saveSceneText } from './manuscript-scenes';", beside, isScenes, names)).toBe(true);
        expect(takesAWriter("import { restoreSceneVersion as r } from '@/app-layer/usecases/manuscript-scenes';", beside, isScenes, names)).toBe(true);
        expect(takesAWriter("import * as scenes from './manuscript-scenes';", beside, isScenes, names)).toBe(true);
        expect(takesAWriter("import { getScene, beatScenesInTx } from './manuscript-scenes';", beside, isScenes, names)).toBe(false);
    });

    it('a model module reached through a chain is found (the walk sees the research model seam from its run usecase)', () => {
        const reach = reachFrom([abs('src/app-layer/usecases/research-run.ts')]);
        expect([...reach.reached.keys()].map(repoRelative)).toContain('src/lib/research/model-seam.ts');
        expect(modelModules()).toContain('src/lib/research/model-seam.ts');
    });
});
