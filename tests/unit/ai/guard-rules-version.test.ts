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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GUARD_RULES_VERSION } from '@/lib/ai/guard';

/** The files whose content decides what the guard refuses. */
const RULE_FILES = ['patterns', 'normalize', 'injection-scanner', 'egress-scanner', 'policy'] as const;

/** Each version and the hash of the rule files it names. */
const RECORDED: Readonly<Record<number, string>> = {
    1: 'sha256:0f0d6b4909e0e131d6933d47e67354e85c38fa9821572ed7240b1a3386f173ae',
};

function rulesHash(): string {
    const h = createHash('sha256');
    for (const f of RULE_FILES) {
        h.update(`${f}\0`);
        h.update(readFileSync(path.join(__dirname, '../../../src/lib/ai/guard', `${f}.ts`), 'utf8').replace(/\r\n/g, '\n'));
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
