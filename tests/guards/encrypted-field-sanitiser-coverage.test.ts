/**
 * Every encrypted author-text field is sanitised on its way in (Phase 1.1,
 * roadmap 1.H item 1, built here so no write path lands unsanitised).
 *
 * Encryption hides a value at rest; it does nothing for whoever later READS
 * the value — the editor, an export, a prompt. So every column of the
 * encrypted-fields manifest (`src/lib/security/encrypted-fields.ts`) is
 * classified below with the sanitiser its write path calls, and this suite
 * checks, from the source in git:
 *
 *   1. every manifest field is classified, and nothing classified is stale;
 *   2. the model is written through Prisma in ONE file, its repository (no
 *      second write path around it), and by no raw INSERT or UPDATE anywhere
 *      in src;
 *   3. every file that CALLS one of the repository's write methods also calls
 *      the field's sanitiser — so a new usecase that writes the model without
 *      it fails here;
 *   4. each sanitiser reaches a primitive of `src/lib/security/sanitize.ts`
 *      (a wrapper that stopped calling one would pass rule 3 vacuously).
 *
 * File-grained on purpose: it proves the call is THERE, not that every value
 * flows through it. The behaviour — a `<script>` written through each path is
 * stored stripped — is tests/integration/bible-validation.test.ts. The
 * checker is proved against synthetic sources at the bottom.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

interface Classification {
    /** The repository object whose write methods store the field. */
    repository: string;
    writeMethods: readonly string[];
    /** The function every caller of those methods must also call. */
    sanitiser: string;
    /** Set when the value is not author input but built from stored, already-sanitised rows. */
    derived?: string;
}

const COVERAGE: Readonly<Record<string, Classification>> = {
    'Book.logline': { repository: 'BookRepository', writeMethods: ['create', 'update'], sanitiser: 'optionalBlock' },
    'BibleElement.summary': { repository: 'BibleElementRepository', writeMethods: ['create', 'update'], sanitiser: 'optionalBlock' },
    'BibleField.value': { repository: 'BibleFieldRepository', writeMethods: ['upsert'], sanitiser: 'normaliseFieldValue' },
    'BibleRelation.note': { repository: 'BibleRelationRepository', writeMethods: ['create', 'updateNote'], sanitiser: 'optionalBlock' },
    'BibleEntryVersion.changeSummary': { repository: 'BibleVersionRepository', writeMethods: ['create'], sanitiser: 'optionalBlock' },
    'BibleEntryVersion.snapshot': {
        repository: 'BibleVersionRepository',
        writeMethods: ['create'],
        sanitiser: 'buildSnapshot',
        derived:
            'The snapshot is serialised from the element and field rows as they stand in the same transaction, every one of which ' +
            'came through the sanitisers above; a restore re-sanitises each value it applies.',
    },
};

/** Each repository object and the one file allowed to write its model through Prisma. */
const REPOSITORIES: Readonly<Record<string, { file: string; model: string }>> = {
    BookRepository: { file: 'src/app-layer/repositories/book.repository.ts', model: 'Book' },
    BibleElementRepository: { file: 'src/app-layer/repositories/bible.repository.ts', model: 'BibleElement' },
    BibleFieldRepository: { file: 'src/app-layer/repositories/bible.repository.ts', model: 'BibleField' },
    BibleRelationRepository: { file: 'src/app-layer/repositories/bible.repository.ts', model: 'BibleRelation' },
    BibleVersionRepository: { file: 'src/app-layer/repositories/bible.repository.ts', model: 'BibleEntryVersion' },
};

/** Wrappers, where each is defined and what it must call; the chain must end at a primitive. */
const PRIMITIVES = ['sanitizePlainText', 'sanitizeRichTextHtml'] as const;
const WRAPPERS: Readonly<Record<string, { file: string; calls: readonly string[] }>> = {
    optionalBlock: { file: 'src/app-layer/usecases/bible-common.ts', calls: ['plainBlock'] },
    requiredLine: { file: 'src/app-layer/usecases/bible-common.ts', calls: ['plainLine'] },
    plainBlock: { file: 'src/lib/bible/text.ts', calls: ['sanitizePlainText'] },
    plainLine: { file: 'src/lib/bible/text.ts', calls: ['sanitizePlainText'] },
    normaliseFieldValue: { file: 'src/lib/bible/field-values.ts', calls: ['plainLine', 'sanitizeRichTextHtml'] },
};

const WRITE_OPS = ['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert'];

// ─── The checker (pure, so the negative controls can drive it) ──────

function parse(file: string, source: string): ts.SourceFile {
    return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Names called as `name(…)`, and `obj.method(…)` pairs, in a source. */
function callsIn(sf: ts.Node): { names: Set<string>; members: Array<{ object: string; method: string }> } {
    const names = new Set<string>();
    const members: Array<{ object: string; method: string }> = [];
    const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
            const callee = n.expression;
            if (ts.isIdentifier(callee)) names.add(callee.text);
            else if (ts.isPropertyAccessExpression(callee)) {
                const target = callee.expression;
                const object = ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : '';
                members.push({ object, method: callee.name.text });
            }
        }
        n.forEachChild(visit);
    };
    visit(sf);
    return { names, members };
}

/** The body of a top-level `function name` or `const name = …` in a source, or null. */
function definitionOf(sf: ts.SourceFile, name: string): ts.Node | null {
    for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
        if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d;
        }
    }
    return null;
}

const delegateOf = (model: string) => model[0].toLowerCase() + model.slice(1);

export function coverageProblems(
    sources: Readonly<Record<string, string>>,
    manifest: Readonly<Record<string, readonly string[]>>,
    coverage: Readonly<Record<string, Classification>>,
): string[] {
    const problems: string[] = [];
    const manifestFields = Object.entries(manifest).flatMap(([model, fields]) => fields.map((f) => `${model}.${f}`));
    for (const f of manifestFields) if (!(f in coverage)) problems.push(`${f}: encrypted but not classified with a sanitiser`);
    for (const f of Object.keys(coverage)) if (!manifestFields.includes(f)) problems.push(`${f}: classified but not in the manifest (stale)`);

    const parsed = Object.fromEntries(Object.entries(sources).map(([file, src]) => [file, parse(file, src)]));
    const calls = Object.fromEntries(Object.entries(parsed).map(([file, sf]) => [file, callsIn(sf)]));

    for (const [field, c] of Object.entries(coverage)) {
        const repo = REPOSITORIES[c.repository];
        if (!repo) {
            problems.push(`${field}: unknown repository ${c.repository}`);
            continue;
        }
        // 2. One Prisma write path per model, and no raw SQL write.
        const delegate = delegateOf(repo.model);
        for (const [file, found] of Object.entries(calls)) {
            if (file === repo.file) continue;
            if (found.members.some((m) => m.object === delegate && WRITE_OPS.includes(m.method))) {
                problems.push(`${field}: ${file} writes ${repo.model} through Prisma outside ${repo.file}`);
            }
            const sql = new RegExp(`(INSERT\\s+INTO|UPDATE)\\s+"${repo.model}"`, 'i');
            if (sql.test(sources[file])) problems.push(`${field}: ${file} writes ${repo.model} with raw SQL`);
        }
        // 3. Every caller of a write method calls the sanitiser.
        const callers = Object.entries(calls).filter(([, found]) => found.members.some((m) => m.object === c.repository && c.writeMethods.includes(m.method)));
        if (callers.length === 0) problems.push(`${field}: nothing calls ${c.repository}.${c.writeMethods.join('/')} (a check over no writer proves nothing)`);
        for (const [file, found] of callers) {
            if (!found.names.has(c.sanitiser)) problems.push(`${field}: ${file} calls ${c.repository}.${c.writeMethods.join('/')} without calling ${c.sanitiser}`);
        }
        // 4. The sanitiser reaches a primitive.
        if (!c.derived) {
            const seen = new Set<string>();
            const reaches = (name: string): boolean => {
                if ((PRIMITIVES as readonly string[]).includes(name)) return true;
                if (seen.has(name)) return false;
                seen.add(name);
                const w = WRAPPERS[name];
                const sf = w && parsed[w.file];
                const def = sf && definitionOf(sf, name);
                if (!def) return false;
                const inside = callsIn(def).names;
                return w.calls.every((callee) => inside.has(callee) && reaches(callee));
            };
            if (!reaches(c.sanitiser)) problems.push(`${field}: ${c.sanitiser} does not reach ${PRIMITIVES.join(' or ')}`);
        }
    }
    return problems;
}

// ─── Against the tree ───────────────────────────────────────────────

const srcFiles = repoRelativeFiles().filter((f) => /^src\/.*\.tsx?$/.test(f));
const sources = Object.fromEntries(srcFiles.map((f) => [f, fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')]));

it('reads the source tree and a non-empty manifest (zero fields is never full coverage)', () => {
    expect(srcFiles.length).toBeGreaterThan(50);
    expect(Object.keys(ENCRYPTED_FIELDS).length).toBeGreaterThan(0);
});

it('every encrypted author-text field is sanitised on every write path', () => {
    expect(coverageProblems(sources, ENCRYPTED_FIELDS, COVERAGE)).toEqual([]);
});

it('the primitives themselves call sanitize-html', () => {
    const sf = parse('sanitize.ts', sources['src/lib/security/sanitize.ts']);
    for (const p of PRIMITIVES) expect(callsIn(definitionOf(sf, p)!).names).toContain('sanitizeHtml');
});

// ─── The checker catches what it should ─────────────────────────────

describe('negative controls', () => {
    const repoFile = 'src/app-layer/repositories/bible.repository.ts';
    const textFile = `export function plainBlock(s: string) { return sanitizePlainText(s); }\nexport function plainLine(s: string) { return sanitizePlainText(s); }`;
    const commonFile = `export function optionalBlock(s: string) { return plainBlock(s); }\nexport function requiredLine(s: string) { return plainLine(s); }`;
    const base = {
        [repoFile]: `export const BibleRelationRepository = { create(db, d) { return db.bibleRelation.create({ data: d }); } };`,
        'src/lib/bible/text.ts': textFile,
        'src/app-layer/usecases/bible-common.ts': commonFile,
    };
    const manifest = { BibleRelation: ['note'] };
    const coverage = { 'BibleRelation.note': COVERAGE['BibleRelation.note'] };

    it('passes a usecase that sanitises before it writes (the controls below fail for their defect)', () => {
        const ok = { ...base, 'src/app-layer/usecases/x.ts': `const n = optionalBlock(i.note); BibleRelationRepository.create(db, { note: n });` };
        expect(coverageProblems(ok, manifest, coverage)).toEqual([]);
    });

    it('flags a usecase that writes without the sanitiser', () => {
        const bad = { ...base, 'src/app-layer/usecases/x.ts': `BibleRelationRepository.create(db, { note: i.note });` };
        expect(coverageProblems(bad, manifest, coverage)).toEqual([
            'BibleRelation.note: src/app-layer/usecases/x.ts calls BibleRelationRepository.create/updateNote without calling optionalBlock',
        ]);
    });

    it('flags a second Prisma write path and a raw SQL write', () => {
        const bad = {
            ...base,
            'src/app-layer/usecases/x.ts': `const n = optionalBlock(i.note); BibleRelationRepository.create(db, { note: n });`,
            'src/lib/sneaky.ts': `db.bibleRelation.update({ data: { note: raw } }); db.$executeRaw\`UPDATE "BibleRelation" SET note = \${raw}\`;`,
        };
        expect(coverageProblems(bad, manifest, coverage)).toEqual(
            expect.arrayContaining([
                `BibleRelation.note: src/lib/sneaky.ts writes BibleRelation through Prisma outside ${repoFile}`,
                'BibleRelation.note: src/lib/sneaky.ts writes BibleRelation with raw SQL',
            ]),
        );
    });

    it('flags a wrapper that stopped sanitising, an unclassified field and a stale one', () => {
        const bad = {
            ...base,
            'src/lib/bible/text.ts': `export function plainBlock(s: string) { return s.trim(); }\nexport function plainLine(s: string) { return s; }`,
            'src/app-layer/usecases/x.ts': `const n = optionalBlock(i.note); BibleRelationRepository.create(db, { note: n });`,
        };
        expect(coverageProblems(bad, manifest, coverage)).toContain('BibleRelation.note: optionalBlock does not reach sanitizePlainText or sanitizeRichTextHtml');
        expect(coverageProblems(base, { ...manifest, BibleRelation: ['note', 'secret'] }, coverage)).toContain(
            'BibleRelation.secret: encrypted but not classified with a sanitiser',
        );
        expect(coverageProblems(base, {}, coverage)).toContain('BibleRelation.note: classified but not in the manifest (stale)');
    });

    it('flags a classified write path nobody calls', () => {
        expect(coverageProblems(base, manifest, coverage)).toContain(
            'BibleRelation.note: nothing calls BibleRelationRepository.create/updateNote (a check over no writer proves nothing)',
        );
    });
});
