/**
 * THE RULE DETECTORS (Phase 4.2, D28): two live facts that cannot both hold,
 * seen by code alone. Pure and deterministic. Rules come first; the nightly
 * deep check (a model) comes second and only for what rules cannot see.
 *
 * Every rule needs the SAME SUBJECT ELEMENT (a linked subject; a name alone is
 * never enough) and is deliberately narrow: a false alarm costs the author a
 * decision, a miss is still open to the deep check.
 *
 *   VALUE        the same single-valued predicate — an AGE (the first number), an
 *                OCCUPATION, a PLACE_TYPE — whose value plainly differs (objects
 *                that differ and neither holds the other) at an OVERLAPPING story
 *                time (`story-clock.ts`). A ROLE or a WANT can hold several values,
 *                so code never calls two of them contradictory.
 *   WHEREABOUTS  two LOCATIONs of one subject that plainly differ at a story
 *                time BOTH facts place (D28 addendum): someone in two places at
 *                once. With the story order, "at the mill" in beat 3 and "in the
 *                city" in beat 5 are two times, not a contradiction. A location
 *                with no story time and no position clashes with nothing here: a
 *                traveller's many undated whereabouts made a pair of every two,
 *                tens of thousands for one subject; the deep check judges them.
 *   KNOWLEDGE    who knows what when: two KNOWLEDGE facts of one subject about the
 *                SAME proposition (the statement's content words, negation removed)
 *                with OPPOSITE polarity, when both times decide they overlap — or
 *                when the subject KNOWS it at a point BEFORE a point where they do
 *                NOT (knowledge is not unlearned). Not knowing first and knowing
 *                later is learning. Undated, it is left to the deep check too.
 *
 * VALUE keeps "unknown overlaps everything" (decided with the addendum): a
 * single-valued predicate holds few distinct values per subject (one claim per
 * value), so it does not blow up, and two undated ages that differ are, nearly
 * always, the very slip the rule exists to catch.
 *
 * A pair is reported once, older first by the caller's order. Nothing here
 * writes: the caller PROPOSES (rule 1).
 */
import { nameKey } from '@/lib/enrichment/validate';
import { contentTokens } from '@/lib/interview/text';
import { negated } from '@/lib/text/negation';
import { before, decidedOverlap, overlaps, NO_ORDER, type ClockFact, type StoryClock } from './story-clock';
import type { ContradictionKind } from './vocabulary';

export interface RuleFact extends ClockFact {
    readonly id: string;
    readonly predicate: string;
    readonly subjectElementId: string | null;
    readonly objectLiteral: string | null;
    readonly statement: string;
}

/** The predicates a VALUE rule may call contradictory (4.1's list, LOCATION moved to WHEREABOUTS). */
export const VALUE_PREDICATES: ReadonlySet<string> = new Set(['AGE', 'OCCUPATION', 'PLACE_TYPE']);

function firstNumber(text: string): string | null {
    return /\d+(?:\.\d+)?/.exec(text)?.[0] ?? null;
}

function valuesDiffer(a: RuleFact, b: RuleFact): boolean {
    if (a.predicate === 'AGE') {
        const x = firstNumber(a.objectLiteral || a.statement);
        const y = firstNumber(b.objectLiteral || b.statement);
        return x !== null && y !== null && Number(x) !== Number(y);
    }
    const x = nameKey(a.objectLiteral ?? '');
    const y = nameKey(b.objectLiteral ?? '');
    if (x === '' || y === '') return false;
    return x !== y && !x.includes(y) && !y.includes(x);
}

/** The words a negation is made of: removed before a proposition is compared. */
const NEGATORS: ReadonlySet<string> = new Set(['not', 'no', 'never', 'cannot', 'nor', 'neither', 'nobody', 'none', 'nothing', 'nowhere', 'noone']);

function isNegator(word: string): boolean {
    const w = word.toLowerCase().replace(/’/g, "'");
    return NEGATORS.has(w) || w.endsWith("n't");
}

/** A statement's proposition: its content words without its negation, sorted (what is known, whoever says it how). */
export function propositionKey(statement: string): string {
    const kept = statement.split(/\s+/).filter((w) => !isNegator(w.replace(/[^\p{L}\p{N}'’]/gu, ''))).join(' ');
    return [...new Set(contentTokens(kept))].sort().join(' ');
}

/** Could code alone call these two facts contradictory, and how? Null when it cannot. */
export function ruleContradiction(a: RuleFact, b: RuleFact, clock: StoryClock = NO_ORDER): ContradictionKind | null {
    if (a.id === b.id || a.predicate !== b.predicate) return null;
    if (a.subjectElementId === null || a.subjectElementId !== b.subjectElementId) return null;
    if (VALUE_PREDICATES.has(a.predicate)) return overlaps(a, b, clock) && valuesDiffer(a, b) ? 'VALUE' : null;
    // D28 addendum: two whereabouts clash only when BOTH times decide that they overlap (never "unknown overlaps").
    if (a.predicate === 'LOCATION') return decidedOverlap(a, b, clock) === true && valuesDiffer(a, b) ? 'WHEREABOUTS' : null;
    if (a.predicate === 'KNOWLEDGE') {
        const na = negated(a.statement);
        const nb = negated(b.statement);
        if (na === nb) return null;
        const pa = propositionKey(a.statement);
        if (pa === '' || pa !== propositionKey(b.statement)) return null;
        if (decidedOverlap(a, b, clock) === true) return 'KNOWLEDGE';
        const knows = na ? b : a;
        const doesNot = na ? a : b;
        return before(knows, doesNot, clock) ? 'KNOWLEDGE' : null;
    }
    return null;
}

export interface RulePair {
    readonly a: string;
    readonly b: string;
    readonly kind: ContradictionKind;
}

/**
 * Every pair of `facts` a rule calls contradictory. Facts are grouped by subject element first (a rule never crosses
 * subjects), so the work is the sum of each group's pairs, not the whole set's; `maxGroup` bounds a group (a subject
 * past it is checked on its first `maxGroup` facts and counted in `cut`).
 */
export function detectRuleContradictions(facts: readonly RuleFact[], clock: StoryClock = NO_ORDER, maxGroup = 400): { pairs: RulePair[]; compared: number; cut: number } {
    const groups = new Map<string, RuleFact[]>();
    for (const f of facts) {
        if (!f.subjectElementId) continue;
        const g = groups.get(f.subjectElementId);
        if (g) g.push(f);
        else groups.set(f.subjectElementId, [f]);
    }
    const pairs: RulePair[] = [];
    let compared = 0;
    let cut = 0;
    for (const group of groups.values()) {
        const g = group.length > maxGroup ? group.slice(0, maxGroup) : group;
        cut += group.length - g.length;
        for (let i = 0; i < g.length; i++) {
            for (let j = i + 1; j < g.length; j++) {
                compared++;
                const kind = ruleContradiction(g[i], g[j], clock);
                if (kind) pairs.push({ a: g[i].id, b: g[j].id, kind });
            }
        }
    }
    return { pairs, compared, cut };
}
