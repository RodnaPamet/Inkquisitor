/**
 * The prose checks' rule version moves with the rules (Phase 5.2, D34).
 *
 * A scene's stored check names the `PROSE_RULES_VERSION` it ran under; a check
 * from an older version reads OUTDATED and the editor asks for it again. So a
 * change to what the rules find that leaves the version where it was would
 * leave every stored check standing. This test hashes the files that decide a
 * finding — the engine and everything it imports, and the exact versions of
 * the MIT packages that run rules (retext and its plugins, write-good) — and
 * fails when they change without the version: bump `PROSE_RULES_VERSION` by one
 * and add the new hash under it in `RECORDED` (the old entries stay: they are
 * the history).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PROSE_RULES_VERSION } from '@/lib/prose-checks/vocabulary';

const ROOT = path.join(__dirname, '../../..');
const ENTRY_POINTS = ['src/lib/prose-checks/engine.ts', 'src/lib/prose-checks/baseline.ts'];
/** The packages whose code runs a rule: their pinned versions are part of the hash. */
const RULE_PACKAGES = ['retext', 'retext-english', 'retext-equality', 'retext-profanities', 'retext-repeated-words', 'write-good'];

/** Each version and the hash it records. */
const RECORDED: Readonly<Record<number, string>> = {
    1: 'sha256:8548ac1bb734cade981fc4520536eb3d9581a759da02b3e5306043cc721159fc',
};

/** The source files `file` imports at run time (relative or `@/`), resolved to repository paths. */
function importsOf(file: string): string[] {
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    const out: string[] = [];
    for (const m of src.matchAll(/^(?:import|export)\s+(?!type\b)[^'";]*?from\s+'([^']+)'/gm)) {
        const spec = m[1];
        const base = spec.startsWith('@/') ? path.join('src', spec.slice(2)) : spec.startsWith('.') ? path.join(path.dirname(file), spec) : null;
        if (!base) continue;
        const found = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((c) => existsSync(path.join(ROOT, c)));
        if (found) out.push(found.split(path.sep).join('/'));
    }
    return out;
}

/** The engine's import closure, sorted. */
export function ruleFiles(): string[] {
    const seen = new Set<string>();
    const queue = [...ENTRY_POINTS];
    while (queue.length > 0) {
        const f = queue.pop()!;
        if (seen.has(f)) continue;
        seen.add(f);
        queue.push(...importsOf(f));
    }
    return [...seen].sort();
}

function rulesHash(): string {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const h = createHash('sha256');
    for (const f of ruleFiles()) {
        // The version line itself is not a rule change.
        const text = readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n').replace(/^export const PROSE_RULES_VERSION = \d+;$/m, '');
        h.update(`${f}\0${text}\0`);
    }
    for (const p of RULE_PACKAGES) h.update(`${p}@${pkg.dependencies[p]}\0`);
    return `sha256:${h.digest('hex')}`;
}

it('the rule packages are pinned to exact versions (a range would move the rules unseen)', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    for (const p of RULE_PACKAGES) expect(pkg.dependencies[p]).toMatch(/^\d+\.\d+\.\d+$/);
});

it('the hashed files are the engine’s closure, and it holds every rule module', () => {
    const files = ruleFiles();
    expect(files).toEqual(expect.arrayContaining(['src/lib/prose-checks/rules/original.ts', 'src/lib/prose-checks/rules/ported.ts', 'src/lib/prose-checks/dialogue.ts', 'src/lib/prose-checks/vocabulary.ts']));
});

it('the rule files hash to what the current version records (else bump PROSE_RULES_VERSION and record the hash)', () => {
    expect(Number.isInteger(PROSE_RULES_VERSION) && PROSE_RULES_VERSION >= 1).toBe(true);
    expect({ version: PROSE_RULES_VERSION, hash: rulesHash() }).toEqual({ version: PROSE_RULES_VERSION, hash: RECORDED[PROSE_RULES_VERSION] });
});

it('versions only move forward: every recorded version up to the current one, and none past it', () => {
    const versions = Object.keys(RECORDED).map(Number).sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: PROSE_RULES_VERSION }, (_, i) => i + 1));
});
