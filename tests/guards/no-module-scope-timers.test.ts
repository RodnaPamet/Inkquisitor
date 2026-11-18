/**
 * No module-scope `setInterval` in application code.
 *
 * An interval created when a module loads, and never cleared, holds its
 * callback, and the callback holds its module's scope, for the life of the
 * process. Under Jest's in-band runner every test file loads its own copy of
 * each module, so one such interval keeps every importing test file's module
 * graph alive to the end of the run (inflect-compliance #4613: its rate limiter
 * did exactly this). A cache or a limiter here sweeps lazily, on a caller's
 * turn (`src/lib/security/rate-limit.ts`, `src/lib/rate-limit/window-store.ts`),
 * and a heartbeat is written from an event, not a timer
 * (`src/app-layer/jobs/heartbeat.ts`).
 *
 * The rule is about MODULE scope. An interval created inside a function — a
 * React effect that clears it on unmount, as the undo toast's countdown does —
 * lives as long as the thing that owns it and is not what this guards. So the
 * check is syntactic: a `setInterval(...)` call (bare, or on `window` /
 * `globalThis`) with no function-like node above it is an offender.
 *
 * The population is git's (`repoFiles`), never a hand-written skip list.
 */
import * as fs from 'node:fs';
import ts from 'typescript';
import { repoFiles, repoRelative } from '../helpers/repo-files';

const SOURCES = [
    ...repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }),
    ...repoFiles({ under: 'scripts', extensions: ['.ts', '.mjs'] }),
];

function isSetIntervalCall(node: ts.Node): boolean {
    if (!ts.isCallExpression(node)) return false;
    const callee = node.expression;
    if (ts.isIdentifier(callee)) return callee.text === 'setInterval';
    if (ts.isPropertyAccessExpression(callee)) {
        const target = callee.expression;
        return (
            callee.name.text === 'setInterval' &&
            ts.isIdentifier(target) &&
            (target.text === 'window' || target.text === 'globalThis' || target.text === 'global')
        );
    }
    return false;
}

function insideFunction(node: ts.Node): boolean {
    for (let p = node.parent; p; p = p.parent) {
        if (ts.isFunctionLike(p) || ts.isClassStaticBlockDeclaration(p)) return true;
    }
    return false;
}

/** Line numbers (1-based) of module-scope setInterval calls in `source`. */
export function moduleScopeIntervals(fileName: string, source: string): number[] {
    const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : fileName.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
    const lines: number[] = [];
    const visit = (node: ts.Node) => {
        if (isSetIntervalCall(node) && !insideFunction(node)) {
            lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return lines;
}

describe('no module-scope setInterval in application code', () => {
    it('scans a real population', () => {
        expect(SOURCES.map(repoRelative)).toEqual(
            expect.arrayContaining(['src/lib/security/rate-limit.ts', 'src/lib/rate-limit/window-store.ts', 'scripts/worker.ts']),
        );
    });

    it('catches a module-scope interval and ignores one owned by a function', () => {
        expect(moduleScopeIntervals('a.ts', 'const t = setInterval(() => sweep(), 1000);')).toEqual([1]);
        expect(moduleScopeIntervals('b.ts', 'export const x = 1;\nwindow.setInterval(tick, 5);')).toEqual([2]);
        expect(moduleScopeIntervals('c.ts', 'if (enabled) { globalThis.setInterval(tick, 5); }')).toEqual([1]);
        expect(
            moduleScopeIntervals(
                'd.tsx',
                'function C() { useEffect(() => { const i = window.setInterval(f, 250); return () => window.clearInterval(i); }, []); return null; }',
            ),
        ).toEqual([]);
        expect(moduleScopeIntervals('e.ts', 'class Q { start() { this.t = setInterval(f, 1); } }')).toEqual([]);
        // A comment or a string naming the API is not a call.
        expect(moduleScopeIntervals('f.ts', '// setInterval(f, 1)\nconst s = "setInterval(f, 1)";')).toEqual([]);
    });

    it('no file creates an interval at module scope', () => {
        const offenders = SOURCES.flatMap((f) =>
            moduleScopeIntervals(f, fs.readFileSync(f, 'utf8')).map((line) => `${repoRelative(f)}:${line}`),
        );
        expect(offenders).toEqual([]);
    });
});
