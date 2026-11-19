/**
 * The frontier (Phase 2.2), exhaustively and without a model:
 *
 *   1. every case of every craft pack's evaluation set: the frontier over the
 *      kind's core fields equals the case's `targetsAnyOf`, in order (content
 *      formats 3.5: it is EXACTLY the eligible frontier);
 *   2. dependency chains, skips, decide-later, answered-with-nothing,
 *      already-answered removal and the pluggable checks, the depth dial;
 *   3. a cyclic or dangling prerequisite never reaches the frontier;
 *   4. properties over generated templates, stored values and answer
 *      histories (design 11.3).
 */
import { BIBLE_KINDS, type BibleKind } from '@/lib/bible/kinds';
import { getTemplate } from '@/lib/bible/templates';
import {
    BIBLE_VALUES_CHECK,
    computeFrontier,
    emptyFrontierReason,
    fieldLevels,
    refsCheck,
    type AnswerFact,
    type FrontierElement,
    type FrontierFieldDef,
} from '@/lib/interview/frontier';
import { getPacks } from '@/lib/interview/packs';
import type { AnswerStatus } from '@/lib/interview/vocabulary';

const ID = 'el-1';

function coreElement(kind: BibleKind, stored: Record<string, unknown>): FrontierElement {
    return {
        elementId: ID,
        kind,
        fields: getTemplate(kind).fields.filter((f) => f.required),
        storedKeys: new Set(Object.entries(stored).filter(([, v]) => v !== null).map(([k]) => k)),
    };
}

function facts(answers: ReadonlyArray<{ status: AnswerStatus; targetsFieldKeys: string[] }>): AnswerFact[] {
    return answers.map((a) => ({ status: a.status, targets: a.targetsFieldKeys.map((fieldKey) => ({ elementId: ID, fieldKey })) }));
}

describe('every craft evaluation case', () => {
    const packs = getPacks();
    const cases = BIBLE_KINDS.flatMap((kind) => packs.craftEvals[kind].map((c) => [c.id, kind, c] as const));

    it('reads them all (a set that found none would pass vacuously)', () => {
        expect(cases.length).toBeGreaterThanOrEqual(150);
    });

    it.each(cases)('%s: the frontier is exactly targetsAnyOf, in order', (_id, kind, c) => {
        const result = computeFrontier({
            elements: [coreElement(kind, c.bibleState)],
            sessionAnswers: facts(c.priorAnswers),
            depth: c.dials.depth,
        });
        expect(result.frontier.map((f) => f.fieldKey)).toEqual(c.expect.targetsAnyOf);
    });
});

// ─── A synthetic chain: a → b → c → d → e, and f alone ─────────────

const field = (key: string, order: number, dependsOn: string[] = [], required = true): FrontierFieldDef => ({ key, order, dependsOn, required });
const CHAIN: FrontierFieldDef[] = [field('a', 1), field('b', 2, ['a']), field('c', 3, ['b']), field('d', 4, ['c']), field('e', 5, ['d']), field('f', 6)];
const chain = (stored: string[] = []): FrontierElement => ({ elementId: ID, kind: 'CUSTOM', fields: CHAIN, storedKeys: new Set(stored) });
const keys = (r: ReturnType<typeof computeFrontier>) => r.frontier.map((f) => f.fieldKey);
const answer = (status: AnswerStatus, ...targets: string[]): AnswerFact => ({ status, targets: targets.map((fieldKey) => ({ elementId: ID, fieldKey })) });

describe('dependency chains and the depth dial', () => {
    it('levels follow the deepest prerequisite', () => {
        expect(Object.fromEntries(fieldLevels(CHAIN))).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 1 });
    });

    it('asks only roots on a fresh element, then one step further per answered round', () => {
        const answers: AnswerFact[] = [];
        const seen: string[][] = [];
        for (let round = 0; round < 6; round++) {
            const r = computeFrontier({ elements: [chain()], sessionAnswers: answers, depth: 5 });
            if (r.frontier.length === 0) break;
            seen.push(keys(r));
            for (const k of keys(r)) answers.push(answer('ANSWERED', k));
        }
        expect(seen).toEqual([['a', 'f'], ['b'], ['c'], ['d'], ['e']]);
    });

    it('never goes deeper than the dial, and says so', () => {
        const r = computeFrontier({ elements: [chain(['a', 'b'])], sessionAnswers: [], depth: 2 });
        expect(keys(r)).toEqual(['f']);
        expect(r.blocked.find((b) => b.fieldKey === 'c')).toMatchObject({ reason: 'TOO_DEEP', level: 3 });
    });

    it('raising the depth never removes a field', () => {
        for (let d = 1; d < 5; d++) {
            const low = keys(computeFrontier({ elements: [chain(['a', 'b', 'c'])], sessionAnswers: [], depth: d }));
            const high = keys(computeFrontier({ elements: [chain(['a', 'b', 'c'])], sessionAnswers: [], depth: d + 1 }));
            expect(high).toEqual(expect.arrayContaining(low));
        }
    });
});

describe('skips, decide-later and answers', () => {
    it.each(['SKIPPED', 'DECIDE_LATER'] as const)('%s: the field is not asked again, and its dependants wait on it', (status) => {
        const r = computeFrontier({ elements: [chain()], sessionAnswers: [answer(status, 'a')], depth: 5 });
        expect(keys(r)).toEqual(['f']);
        expect(r.blocked.find((b) => b.fieldKey === 'a')).toMatchObject({ reason: 'TOUCHED' });
        expect(r.blocked.find((b) => b.fieldKey === 'b')).toMatchObject({ reason: 'WAITS_ON_DEFERRED', waitsOn: ['a'] });
        // Deeper fields wait on an open prerequisite, which itself waits on the deferred one.
        expect(r.blocked.find((b) => b.fieldKey === 'c')).toMatchObject({ reason: 'WAITS_ON', waitsOn: ['b'] });
    });

    it('a deferred prerequisite is reported first, even when the dependant is also too deep', () => {
        const r = computeFrontier({ elements: [chain()], sessionAnswers: [answer('DECIDE_LATER', 'a')], depth: 1 });
        expect(r.blocked.find((b) => b.fieldKey === 'b')).toMatchObject({ reason: 'WAITS_ON_DEFERRED' });
        expect(emptyFrontierReason(r.blocked.filter((b) => b.fieldKey !== 'f'))).toBe('FRONTIER_EMPTY');
    });

    it('an ANSWERED answer satisfies every field it targeted, mechanically', () => {
        const r = computeFrontier({ elements: [chain()], sessionAnswers: [answer('ANSWERED', 'a', 'f')], depth: 5 });
        expect(keys(r)).toEqual(['b']);
        expect(r.answeredInSession.map((x) => x.fieldKey)).toEqual(['a', 'f']);
    });

    it('a re-answer after a skip counts as the answer the caller passes (the latest revision)', () => {
        const r = computeFrontier({ elements: [chain()], sessionAnswers: [answer('ANSWERED', 'a')], depth: 5 });
        expect(keys(r)).toContain('b');
    });

    it('an answer about another element changes nothing here', () => {
        const other: AnswerFact = { status: 'ANSWERED', targets: [{ elementId: 'el-2', fieldKey: 'a' }] };
        expect(keys(computeFrontier({ elements: [chain()], sessionAnswers: [other], depth: 5 }))).toEqual(['a', 'f']);
    });
});

describe('what the book already answers comes off first (rule 5)', () => {
    it('a stored value is never on the frontier, and is reported answered by the bible', () => {
        const r = computeFrontier({ elements: [chain(['a'])], sessionAnswers: [], depth: 5 });
        expect(keys(r)).toEqual(['b', 'f']);
        expect(r.answered).toEqual([{ elementId: ID, fieldKey: 'a', by: 'bible-values', level: 1 }]);
    });

    it('a pluggable check answers fields too, after the bible, and satisfies their dependants', () => {
        const concept = refsCheck('concept-stated', [{ elementId: ID, fieldKey: 'f' }, { elementId: ID, fieldKey: 'a' }]);
        const r = computeFrontier({ elements: [chain(['a'])], sessionAnswers: [], checks: [concept], depth: 5 });
        expect(keys(r)).toEqual(['b']);
        expect(r.answered.map((x) => `${x.fieldKey}:${x.by}`)).toEqual(['a:bible-values', 'f:concept-stated']);
    });

    it('the bible check always runs, whatever checks the caller passes', () => {
        const none = { name: 'nothing', answered: () => [] };
        const r = computeFrontier({ elements: [chain(['a'])], sessionAnswers: [], checks: [none], depth: 5 });
        expect(keys(r)).not.toContain('a');
        expect(BIBLE_VALUES_CHECK.name).toBe('bible-values');
    });

    it('core fields lead the frontier, optional ones follow, each in template order', () => {
        const fields = [field('x', 1, [], false), field('a', 2), field('y', 3, [], false), field('b', 4)];
        const r = computeFrontier({ elements: [{ elementId: ID, kind: 'CUSTOM', fields, storedKeys: new Set() }], sessionAnswers: [], depth: 5 });
        expect(keys(r)).toEqual(['a', 'b', 'x', 'y']);
    });

    it('several elements are asked in the order given', () => {
        const e2 = { ...chain(), elementId: 'el-2' };
        const r = computeFrontier({ elements: [e2, chain()], sessionAnswers: [], depth: 1 });
        expect(r.frontier.map((f) => f.elementId)).toEqual(['el-2', 'el-2', ID, ID]);
    });
});

describe('cycles and dangling prerequisites never reach the frontier', () => {
    it('a cycle is unreachable (the template schema refuses one; this is the second line)', () => {
        const cyclic = [field('p', 1, ['q']), field('q', 2, ['p']), field('r', 3)];
        expect(fieldLevels(cyclic).get('p')).toBe(Infinity);
        const r = computeFrontier({ elements: [{ elementId: ID, kind: 'CUSTOM', fields: cyclic, storedKeys: new Set() }], sessionAnswers: [], depth: 5 });
        expect(keys(r)).toEqual(['r']);
    });

    it('a prerequisite outside the considered fields is unreachable', () => {
        const dangling = [field('p', 1, ['missing'])];
        expect(keys(computeFrontier({ elements: [{ elementId: ID, kind: 'CUSTOM', fields: dangling, storedKeys: new Set() }], sessionAnswers: [], depth: 5 }))).toEqual([]);
    });
});

describe('why an empty frontier stops', () => {
    it('only too-deep fields left: raise the depth (NOTHING_AT_DEPTH)', () => {
        const r = computeFrontier({ elements: [chain(['a', 'f'])], sessionAnswers: [answer('ANSWERED', 'b')], depth: 2 });
        expect(keys(r)).toEqual([]);
        expect(emptyFrontierReason(r.blocked)).toBe('NOTHING_AT_DEPTH');
    });

    it('everything answered, or set aside: FRONTIER_EMPTY', () => {
        expect(emptyFrontierReason([])).toBe('FRONTIER_EMPTY');
        const r = computeFrontier({ elements: [chain(['f'])], sessionAnswers: [answer('SKIPPED', 'a')], depth: 5 });
        expect(keys(r)).toEqual([]);
        expect(emptyFrontierReason(r.blocked)).toBe('FRONTIER_EMPTY');
    });
});

// ─── Properties ────────────────────────────────────────────────────

/** Mulberry32: a seeded generator, so a failing case is reproducible. */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomTemplate(r: () => number): FrontierFieldDef[] {
    const n = 2 + Math.floor(r() * 12);
    const fields: FrontierFieldDef[] = [];
    for (let i = 0; i < n; i++) {
        const deps = fields.filter(() => r() < 0.25).map((f) => f.key);
        fields.push(field(`k${i}`, i + 1, deps, r() < 0.6));
    }
    return fields;
}

describe('properties over generated templates and histories (design 11.3)', () => {
    const STATUSES: AnswerStatus[] = ['ANSWERED', 'SKIPPED', 'DECIDE_LATER'];
    const runs = Array.from({ length: 400 }, (_, i) => i + 1);

    it.each(runs.map((s) => [s]))('seed %i', (seed) => {
        const r = rng(seed);
        const fields = randomTemplate(r);
        const levels = fieldLevels(fields);
        const stored = new Set(fields.filter(() => r() < 0.3).map((f) => f.key));
        const history = fields.filter(() => r() < 0.3).map((f) => answer(STATUSES[Math.floor(r() * 3)], f.key));
        const depth = 1 + Math.floor(r() * 5);
        const element: FrontierElement = { elementId: ID, kind: 'CUSTOM', fields, storedKeys: stored };
        const res = computeFrontier({ elements: [element], sessionAnswers: history, depth });
        const touched = new Set(history.flatMap((h) => h.targets.map((t) => t.fieldKey)));
        const satisfied = new Set([...stored, ...history.filter((h) => h.status === 'ANSWERED').flatMap((h) => h.targets.map((t) => t.fieldKey))]);

        for (const f of res.frontier) {
            const def = fields.find((x) => x.key === f.fieldKey)!;
            expect(stored.has(f.fieldKey)).toBe(false); // nothing stored is asked
            expect(touched.has(f.fieldKey)).toBe(false); // nothing asked this session is asked again
            expect(def.dependsOn.every((d) => satisfied.has(d))).toBe(true); // prerequisites settled
            expect(levels.get(f.fieldKey)!).toBeLessThanOrEqual(depth); // within the dial
        }
        // Every field is accounted for exactly once: frontier, blocked, answered by the bible, or answered in session.
        const accounted = [...res.frontier, ...res.blocked, ...res.answered, ...res.answeredInSession].map((x) => x.fieldKey).sort();
        expect(accounted).toEqual(fields.map((f) => f.key).sort());
        // Raising the depth never removes a field.
        if (depth < 5) {
            const deeper = computeFrontier({ elements: [element], sessionAnswers: history, depth: depth + 1 }).frontier.map((f) => f.fieldKey);
            expect(deeper).toEqual(expect.arrayContaining(res.frontier.map((f) => f.fieldKey)));
        }
        // Answering a frontier field adds only fields whose prerequisites it completes.
        if (res.frontier.length > 0) {
            const k = res.frontier[0].fieldKey;
            const after = computeFrontier({ elements: [element], sessionAnswers: [...history, answer('ANSWERED', k)], depth });
            const added = after.frontier.map((f) => f.fieldKey).filter((x) => !res.frontier.some((f) => f.fieldKey === x));
            for (const a of added) expect(fields.find((x) => x.key === a)!.dependsOn).toContain(k);
        }
        // A skipped field never returns in the session.
        for (const h of history.filter((x) => x.status !== 'ANSWERED')) {
            for (const t of h.targets) expect(res.frontier.some((f) => f.fieldKey === t.fieldKey)).toBe(false);
        }
    });
});
