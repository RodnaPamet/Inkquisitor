/**
 * Every `findMany` is bounded (Phase 1.H, item 4). A read with no `take`
 * returns however many rows the table grows to: the book board read every
 * element of a book until 1.H, and a list capped without saying so hid the
 * rest (#18). So every `.findMany(` call under `src/` passes an object
 * literal with a `take` — a constant, a parameter, or `cap + 1` so the
 * caller can tell a cut list — or carries the comment
 * `// guardrail-allow: unbounded — <reason>` on the line above it.
 *
 * Read with the TypeScript parser, so a `take` inside a nested `select` or a
 * comment does not count, and a call whose argument is a variable (whose
 * shape the guard cannot see) needs the explicit comment.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const ALLOW = /\/\/\s*guardrail-allow:\s*unbounded\s+—\s*\S/;

/** `file:line` of every unbounded `findMany` call in a source. Pure, for the negative controls. */
export function unboundedFindMany(file: string, source: string): string[] {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const lines = source.split('\n');
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'findMany') {
            const [arg] = n.arguments;
            const bounded =
                arg !== undefined &&
                ts.isObjectLiteralExpression(arg) &&
                arg.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === 'take');
            const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
            if (!bounded && !ALLOW.test(lines[line - 1] ?? '')) out.push(`${file}:${line + 1}`);
        }
        n.forEachChild(visit);
    };
    visit(sf);
    return out;
}

const files = repoRelativeFiles().filter((f) => /^src\/.*\.tsx?$/.test(f));

it('reads the source tree, and finds the list queries (none found would pass vacuously)', () => {
    const calls = files.reduce((n, f) => n + (fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').match(/\.findMany\(/g)?.length ?? 0), 0);
    expect(calls).toBeGreaterThanOrEqual(10);
});

it('every findMany under src/ is bounded by a take', () => {
    expect(files.flatMap((f) => unboundedFindMany(f, fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')))).toEqual([]);
});

describe('negative controls', () => {
    it('flags a findMany with no take, with a take only in a nested select, or with an argument it cannot see', () => {
        expect(unboundedFindMany('a.ts', 'db.book.findMany({ where: { workspaceId } });')).toEqual(['a.ts:1']);
        expect(unboundedFindMany('a.ts', 'db.book.findMany();')).toEqual(['a.ts:1']);
        expect(unboundedFindMany('a.ts', 'db.book.findMany({ select: { members: { take: 1 } } });')).toEqual(['a.ts:1']);
        expect(unboundedFindMany('a.ts', 'const q = { take: 5 };\ndb.book.findMany(q);')).toEqual(['a.ts:2']);
    });

    it('passes a take of any form, and an unbounded read that says why', () => {
        expect(unboundedFindMany('a.ts', 'db.book.findMany({ where: {}, take: 200 });')).toEqual([]);
        expect(unboundedFindMany('a.ts', 'db.book.findMany({ take, select: S });')).toEqual([]);
        expect(unboundedFindMany('a.ts', 'db.book.findMany({ take: cap + 1 });')).toEqual([]);
        expect(unboundedFindMany('a.ts', '// guardrail-allow: unbounded — a closed table of six rows\ndb.kind.findMany({});')).toEqual([]);
        // A reason is required: the bare marker does not count.
        expect(unboundedFindMany('a.ts', '// guardrail-allow: unbounded\ndb.kind.findMany({});')).toEqual(['a.ts:2']);
    });
});
