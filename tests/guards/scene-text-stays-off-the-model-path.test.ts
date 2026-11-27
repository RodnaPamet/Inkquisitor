/**
 * D3: NO MODEL OUTPUT IS EVER WRITTEN TO A SCENE'S TEXT (Phase 5.1) — held by
 * structure, not by care.
 *
 * A scene's text column (and a version of it) is written by ONE module, the
 * scene text writer `src/app-layer/usecases/manuscript-text.ts`:
 *
 *   1. the repository methods that write the text — `ManuscriptSceneRepository`
 *      `.setText` / `.createScenes`, `SceneVersionRepository.create` /
 *      `.createMany` — are called from that module and nowhere else, no other
 *      file writes the scene or version table through Prisma, and no raw SQL
 *      anywhere in src writes either;
 *   2. the writer's functions are taken only by the modules listed here (the
 *      scene usecases: autosave, checkpoint, restore; the import), by name;
 *   3. NOTHING on that write path — the writer, its callers, and everything
 *      they reach through their imports, as the bundler sees them — reaches the
 *      model layer: the SDK's one file, `callStructured`, the server-tool loop,
 *      the model stub, the model-calls usecase, or any feature's model seam;
 *   4. and the research acceptance, which writes a finding to a scene's NOTE
 *      (`manuscript-notes.ts`), reaches neither the text writer nor its methods.
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

/** Does a source take one of the seam's writers (by name, a namespace, a default, a re-export, a dynamic import)? */
export function takesAWriter(source: string, file: string, isSeam: (spec: string) => boolean): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
        if (found) return;
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && isSeam(n.moduleSpecifier.text)) {
            const clause = n.importClause;
            if (clause && !clause.isTypeOnly) {
                if (clause.name) found = true;
                const named = clause.namedBindings;
                if (named && ts.isNamespaceImport(named)) found = true;
                if (named && ts.isNamedImports(named) && named.elements.some((e) => !e.isTypeOnly && SEAM_WRITERS.includes((e.propertyName ?? e.name).text))) found = true;
            }
        } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && isSeam(n.moduleSpecifier.text) && !n.isTypeOnly) {
            const clause = n.exportClause;
            if (!clause || ts.isNamespaceExport(clause) || clause.elements.some((e) => SEAM_WRITERS.includes((e.propertyName ?? e.name).text))) found = true;
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

function resolvesToSeam(spec: string, from: string): boolean {
    const base = spec.startsWith('@/') ? path.join(REPO_ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
    return base !== null && [base, `${base}.ts`].includes(abs(SEAM));
}

const sources = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).map((f) => ({ file: f, rel: repoRelative(f), source: fs.readFileSync(f, 'utf8') }));

describe('the scene text column has one writer', () => {
    it('finds the writer, its methods and its callers (a guard that found none would pass vacuously)', () => {
        expect(fs.existsSync(abs(SEAM))).toBe(true);
        const repo = fs.readFileSync(abs(REPOSITORY), 'utf8');
        for (const [, method] of TEXT_METHODS) expect(repo).toContain(`async ${method}(`);
        for (const c of ALLOWED_CALLERS) expect(fs.existsSync(abs(c))).toBe(true);
        expect(modelModules().length).toBeGreaterThanOrEqual(10);
    });

    it('calls the text-writing repository methods only from the writer', () => {
        const hits = sources.filter((s) => s.rel !== SEAM && callsOf(s.source, s.file).some(([obj, m]) => TEXT_METHODS.some(([o, mm]) => o === obj && mm === m)));
        expect(hits.map((h) => h.rel)).toEqual([]);
    });

    it('writes the scene and version tables through Prisma only in the repository, and by no raw SQL', () => {
        const delegate = /\.(manuscriptScene|sceneVersion)\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert)\s*\(/;
        const raw = /\b(INSERT\s+INTO|UPDATE)\s+"(ManuscriptScene|SceneVersion)"/i;
        expect(sources.filter((s) => s.rel !== REPOSITORY && delegate.test(s.source)).map((s) => s.rel)).toEqual([]);
        expect(sources.filter((s) => raw.test(s.source)).map((s) => s.rel)).toEqual([]);
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

    it('a model module reached through a chain is found (the walk sees the research model seam from its run usecase)', () => {
        const reach = reachFrom([abs('src/app-layer/usecases/research-run.ts')]);
        expect([...reach.reached.keys()].map(repoRelative)).toContain('src/lib/research/model-seam.ts');
        expect(modelModules()).toContain('src/lib/research/model-seam.ts');
    });
});
