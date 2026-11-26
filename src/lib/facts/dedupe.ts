/**
 * DEDUPLICATION AND CONTRADICTION (Phase 4.1, D27). Pure and deterministic.
 *
 * ONE LIVE FACT PER CLAIM. A claim is what a bible fact says, independent of
 * its wording's accidents: the entry that owns it (an element, or a relation),
 * its predicate, its subject element, its object (name key) and its statement
 * reduced to its content words (normalised, stop words dropped, stemmed) with
 * its polarity kept ("never learned to swim" is never the claim "learned to
 * swim"). `claimParts` is that list; the caller keys it (`claim-key.ts`,
 * HMAC under the workspace's subkey) and the database holds one live fact per
 * key in a book (`StoryFact_one_live_claim`). A fact restating a live one is
 * not written again: its provenance is.
 *
 * CONTRADICTION is only ever PROPOSED (rule 1): both facts stay live until the
 * author decides. Two ways to see one, each recorded as its basis:
 *
 *   RULE    code: the same subject element and a single-valued predicate whose
 *           value plainly differs — an AGE (the first number), a LOCATION, an
 *           OCCUPATION, a PLACE_TYPE (objects that differ and neither holds the
 *           other) — at an overlapping story time (equal, or either unstated).
 *           Deliberately narrow: a ROLE or a WANT can hold several values, so
 *           code never calls two of them a contradiction.
 *   MODEL   the call named an existing fact shown to it (graphiti's design);
 *           code keeps it only when that fact is about the same subject element.
 *
 * NO_LONGER_STATED: an earlier fact of the SAME entry that this version
 * neither restates nor still contains (its quote is gone from the entry) is
 * proposed too — a cleared field must not keep answering for the author
 * without their say.
 *
 * A new fact that restates a live one raises no contradiction (it repeats,
 * it does not replace); a pair is proposed once (the caller and the database).
 */
import { nameKey } from '@/lib/enrichment/validate';
import { contentTokens } from '@/lib/interview/text';
import { locateQuote, foldWithOrigins } from '@/lib/sources/quote';
import { negated } from '@/lib/text/negation';
import type { FactProposalBasis } from './vocabulary';

/** Who owns a bible fact: the element a version is of, or the relation. */
export interface FactOwner {
    readonly kind: 'BIBLE_VERSION' | 'RELATION_VERSION';
    readonly id: string;
}

export interface ClaimInput {
    readonly predicate: string;
    readonly subjectElementId: string | null;
    readonly objectLiteral: string | null;
    readonly statement: string;
}

/** The parts a claim key is made of (the header). The caller keys them; equal parts are one claim. */
export function claimParts(owner: FactOwner, f: ClaimInput): string[] {
    return [owner.kind, owner.id, f.predicate, f.subjectElementId ?? '', nameKey(f.objectLiteral ?? ''), contentTokens(f.statement).join(' '), negated(f.statement) ? 'neg' : 'pos'];
}

/** The predicates code may call contradictory on its own (the header's RULE). */
export const RULE_PREDICATES: ReadonlySet<string> = new Set(['AGE', 'LOCATION', 'OCCUPATION', 'PLACE_TYPE']);

export interface ResolvableFact {
    readonly predicate: string;
    readonly subjectElementId: string | null;
    readonly objectLiteral: string | null;
    readonly statement: string;
    readonly storyTimeFrom: string | null;
    readonly storyTimeTo: string | null;
}

function firstNumber(text: string): string | null {
    return /\d+(?:\.\d+)?/.exec(text)?.[0] ?? null;
}

function timeKey(t: string | null): string | null {
    return t && t.trim() !== '' ? foldWithOrigins(t).text : null;
}

/** Do the two facts hold at an overlapping story time (the same stated times, or either unstated)? */
export function timesOverlap(a: ResolvableFact, b: ResolvableFact): boolean {
    const [af, at, bf, bt] = [timeKey(a.storyTimeFrom), timeKey(a.storyTimeTo), timeKey(b.storyTimeFrom), timeKey(b.storyTimeTo)];
    if ((af === null && at === null) || (bf === null && bt === null)) return true;
    return af === bf && at === bt;
}

/** The RULE: could code alone call these two facts contradictory? */
export function ruleContradicts(a: ResolvableFact, b: ResolvableFact): boolean {
    if (a.predicate !== b.predicate || !RULE_PREDICATES.has(a.predicate)) return false;
    if (a.subjectElementId === null || a.subjectElementId !== b.subjectElementId) return false;
    if (!timesOverlap(a, b)) return false;
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

export interface NewFact extends ResolvableFact {
    /** The claim key (keyed `claimParts`). */
    readonly key: string;
    /** Indices into `shown` the model named. */
    readonly contradicts: readonly number[];
}

export interface LiveFact extends ResolvableFact {
    readonly id: string;
    /** A bible fact's claim key; NULL for a source fact. */
    readonly key: string | null;
    readonly quote: string;
    /** Owned by the entry being extracted (an earlier version of it): only these may be NO_LONGER_STATED. */
    readonly sameOwner: boolean;
}

export interface ResolutionPlan {
    /** Indices of the new facts to insert (first of each claim). */
    insert: number[];
    /** Live facts restated by this version (provenance), with the new fact that restated each. */
    restated: Array<{ factId: string; newIndex: number }>;
    /** Older live fact → newer (by the new fact's index), and how it was seen. */
    contradictions: Array<{ olderId: string; newIndex: number; basis: Extract<FactProposalBasis, 'RULE' | 'MODEL'> }>;
    /** Earlier facts of the same entry the version no longer states. */
    noLongerStated: string[];
    /** Counted, never rows. */
    counts: { duplicatesInVersion: number; modelOtherSubject: number };
}

/**
 * Resolve a version's new facts against the live facts (the header): which to insert, which live facts they
 * restate, which they contradict, and which earlier facts of the entry it no longer states. `shown` is the
 * list the call was shown, in its order (the model's `contradicts` index into it); `live` is every live fact
 * the version is resolved against (the shown ones among them). `entry` is the version's whole rendered text.
 */
export function resolveFacts(input: { fresh: readonly NewFact[]; shown: readonly LiveFact[]; live: readonly LiveFact[]; entry: string }): ResolutionPlan {
    const plan: ResolutionPlan = { insert: [], restated: [], contradictions: [], noLongerStated: [], counts: { duplicatesInVersion: 0, modelOtherSubject: 0 } };
    const liveByKey = new Map<string, LiveFact>();
    for (const f of input.live) if (f.key) liveByKey.set(f.key, f);
    const seen = new Set<string>();
    const restatedIds = new Set<string>();
    const pairs = new Set<string>();
    input.fresh.forEach((fact, i) => {
        if (seen.has(fact.key)) {
            plan.counts.duplicatesInVersion++;
            return;
        }
        seen.add(fact.key);
        const held = liveByKey.get(fact.key);
        if (held) {
            plan.restated.push({ factId: held.id, newIndex: i });
            restatedIds.add(held.id);
            return;
        }
        plan.insert.push(i);
    });
    const inserted = new Set(plan.insert);
    const propose = (olderId: string, newIndex: number, basis: 'RULE' | 'MODEL') => {
        const key = `${olderId}|${newIndex}`;
        if (pairs.has(key)) return;
        pairs.add(key);
        plan.contradictions.push({ olderId, newIndex, basis });
    };
    for (const i of plan.insert) {
        const fact = input.fresh[i];
        for (const older of input.live) {
            if (older.key !== null && older.key === fact.key) continue;
            if (ruleContradicts(fact, older)) propose(older.id, i, 'RULE');
        }
        for (const n of fact.contradicts) {
            const older = input.shown[n];
            if (!older) continue;
            if (older.subjectElementId === null || older.subjectElementId !== fact.subjectElementId) {
                plan.counts.modelOtherSubject++;
                continue;
            }
            propose(older.id, i, 'MODEL');
        }
    }
    // A fact restated in this very version is never proposed as contradicted by it.
    plan.contradictions = plan.contradictions.filter((c) => !restatedIds.has(c.olderId) && inserted.has(c.newIndex));
    // Whatever ANY of the version's facts contradicts (a restated one too) is not "no longer stated": it is replaced,
    // and that is proposed (or was, and the author decided) with the fact that replaces it.
    const contradicted = new Set(plan.contradictions.map((c) => c.olderId));
    for (const r of plan.restated) {
        const fact = input.fresh[r.newIndex];
        for (const older of input.live) if (older.id !== r.factId && (ruleContradicts(fact, older) || fact.contradicts.some((n) => input.shown[n]?.id === older.id))) contradicted.add(older.id);
    }
    for (const older of input.live) {
        // A fact this version contradicts is already proposed, with the fact that replaces it.
        if (!older.sameOwner || restatedIds.has(older.id) || contradicted.has(older.id)) continue;
        if (!locateQuote(older.quote, input.entry)) plan.noLongerStated.push(older.id);
    }
    return plan;
}
