/**
 * The guard's rule version moves with its rules (Phase 4.H-b, D32).
 *
 * Bible fact extraction re-sends a section the guard refused once the guard's
 * rule version is newer than the one that refused it, so a change to what the
 * guard refuses that leaves `GUARD_RULES_VERSION` where it was would never
 * re-send anything. This test hashes the files that decide a refusal and fails
 * when they change without the version: bump `GUARD_RULES_VERSION` by one and
 * add the new hash under it in `RECORDED` (the old entries stay: they are the
 * history).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { GUARD_RULES_VERSION } from '@/lib/ai/guard';

/**
 * The files whose content decides what the guard refuses: the guard's own modules (`index.ts` included: it decides
 * how a block's text and label combine into a verdict) and every module they import (the 4.H-b review: the
 * invisible-character stripping the normalisation runs). The closure test below holds this list to the import graph.
 */
const RULE_FILES = [
    'src/lib/ai/guard/index.ts',
    'src/lib/ai/guard/patterns.ts',
    'src/lib/ai/guard/normalize.ts',
    'src/lib/ai/guard/injection-scanner.ts',
    'src/lib/ai/guard/egress-scanner.ts',
    'src/lib/ai/guard/policy.ts',
    'src/lib/text/invisible-chars.ts',
] as const;
/** The version file itself: changing the number is not a rule change. */
const VERSION_FILE = 'src/lib/ai/guard/version.ts';
const ROOT = path.join(__dirname, '../../..');

/** Each version and the hash of the rule files it names. */
const RECORDED: Readonly<Record<number, string>> = {
    1: 'sha256:ceffe18e7c27a2b2b1b128d86c4b05d433e7772d281a1fc82b28dfde219359db',
};

function rulesHash(): string {
    const h = createHash('sha256');
    for (const f of RULE_FILES) {
        h.update(`${f}\0`);
        h.update(readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n'));
        h.update('\0');
    }
    return `sha256:${h.digest('hex')}`;
}

it('the guard rule files hash to what the current version records (else bump GUARD_RULES_VERSION and record the hash)', () => {
    expect(Number.isInteger(GUARD_RULES_VERSION) && GUARD_RULES_VERSION >= 1).toBe(true);
    expect({ version: GUARD_RULES_VERSION, hash: rulesHash() }).toEqual({ version: GUARD_RULES_VERSION, hash: RECORDED[GUARD_RULES_VERSION] });
});

it('versions only move forward: every recorded version up to the current one, and none past it', () => {
    const versions = Object.keys(RECORDED).map(Number).sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: GUARD_RULES_VERSION }, (_, i) => i + 1));
});

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

it('the hashed files are exactly the guard and everything it imports (a new import cannot change refusals unseen)', () => {
    const seen = new Set<string>();
    const queue = ['src/lib/ai/guard/index.ts'];
    while (queue.length > 0) {
        const f = queue.pop()!;
        if (seen.has(f)) continue;
        seen.add(f);
        queue.push(...importsOf(f));
    }
    seen.delete(VERSION_FILE);
    expect([...seen].sort()).toEqual([...RULE_FILES].sort());
});
