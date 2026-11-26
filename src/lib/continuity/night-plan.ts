/**
 * ONE NIGHT'S PAGE OF A BOOK (Phase 4.2, D28). Pure.
 *
 * A PASS checks every subject (a linked element) with a live fact created since
 * the last complete pass, each in a call that holds ALL of that subject's live
 * facts — the new beside the old, which is where a contradiction lies — in a
 * STABLE order (`subjectOrderKey`: kind, then id), from the pass's
 * CURSOR (the last subject a call covered). A night makes at most `maxCalls`
 * calls of at most `maxFacts` facts each:
 *
 *   • subjects are packed whole, in order, while the call has room;
 *   • a subject with more facts than one call holds gets a call of its own, its
 *     NEWEST `maxFacts` facts (what changed), the rest counted in `cut`;
 *   • each call's worst case must fit the per-call budget: a call over it drops
 *     its last subject, and a lone subject is halved down to `minFacts`; past
 *     that the night stops `overBudget`, no call made for that subject, the
 *     cursor where it was.
 *
 * What the calls cover moves the cursor; what is left is `remaining` subjects,
 * the next night's. Work is counted, never timed.
 */

export interface PlannedFact {
    readonly id: string;
    /** Newer facts sort first when a subject is cut. */
    readonly createdAt: number;
}

export interface PlannedSubject<F extends PlannedFact> {
    readonly key: string;
    readonly facts: readonly F[];
}

export interface PlannedCall<F extends PlannedFact> {
    readonly subjectKeys: readonly string[];
    readonly facts: readonly F[];
}

export interface NightPlan<F extends PlannedFact> {
    calls: Array<PlannedCall<F>>;
    /** The cursor after the night's calls (the last subject they cover), or the cursor given when they cover none. */
    cursor: string | null;
    /** Subjects fully covered by the calls. */
    covered: number;
    /** Subjects of the pass left for later nights. */
    remaining: number;
    /** Facts of oversized subjects no call was shown. */
    cut: number;
    /** A subject no call can carry inside the budget: the night stops there. */
    overBudget: boolean;
    /** That subject's key (4.H-a: what is passed over once it has failed `CONTINUITY_PAGE_FAILURES_MAX` nights), or null. */
    blockedKey: string | null;
}

/**
 * A subject's place in the pass: kind, then id (stable while the book changes around it). The key is stored as the
 * pass's cursor, so it holds no author text (never the element's name) and no character PostgreSQL refuses in a text
 * column (a NUL separator did: 22021).
 */
export function subjectOrderKey(kind: string, id: string): string {
    return `${kind}:${id}`;
}

export function planNight<F extends PlannedFact>(input: {
    subjects: ReadonlyArray<PlannedSubject<F>>;
    cursor: string | null;
    maxCalls: number;
    maxFacts: number;
    minFacts: number;
    budget: number;
    /** A call's worst case over these facts. */
    worst: (facts: readonly F[]) => number;
}): NightPlan<F> {
    const sorted = [...input.subjects].filter((s) => s.facts.length > 0).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const pending = input.cursor === null ? sorted : sorted.filter((s) => s.key > input.cursor!);
    const calls: Array<PlannedCall<F>> = [];
    let i = 0;
    let cut = 0;
    let overBudget = false;
    let blockedKey: string | null = null;
    while (calls.length < input.maxCalls && i < pending.length) {
        let keys: string[] = [];
        let facts: F[] = [];
        const start = i;
        while (i < pending.length) {
            const s = pending[i];
            if (s.facts.length > input.maxFacts) {
                if (keys.length > 0) break;
                const newest = [...s.facts].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1)).slice(0, input.maxFacts);
                keys = [s.key];
                facts = newest;
                i++;
                break;
            }
            if (facts.length + s.facts.length > input.maxFacts) break;
            keys.push(s.key);
            facts = [...facts, ...s.facts];
            i++;
        }
        // Fit the budget: drop whole subjects from the end, then halve a lone one.
        while (input.worst(facts) > input.budget) {
            if (keys.length > 1) {
                const dropped = pending[--i];
                keys = keys.slice(0, -1);
                const drop = new Set(dropped.facts.map((f) => f.id));
                facts = facts.filter((f) => !drop.has(f.id));
                continue;
            }
            const half = Math.floor(facts.length / 2);
            if (half < input.minFacts) {
                overBudget = true;
                break;
            }
            facts = facts.slice(0, half);
        }
        if (overBudget) {
            i = start;
            blockedKey = pending[start].key;
            break;
        }
        const s = pending[i - 1];
        if (keys.length === 1 && s && s.facts.length > facts.length) cut += s.facts.length - facts.length;
        calls.push({ subjectKeys: keys, facts });
    }
    const coveredKeys = calls.flatMap((c) => c.subjectKeys);
    return {
        calls,
        cursor: coveredKeys.length > 0 ? coveredKeys[coveredKeys.length - 1] : input.cursor,
        covered: coveredKeys.length,
        remaining: pending.length - coveredKeys.length,
        cut,
        overBudget,
        blockedKey,
    };
}
