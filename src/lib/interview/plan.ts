/**
 * Planning a round from the frontier (Phase 2.2; design 4.2). Pure.
 *
 *   targets      every frontier field, in frontier order, up to the detail
 *                dial's round cap; fields beyond it stay on the frontier and
 *                lead the next round (`carried`), so nothing is lost and the
 *                round budget decides how far the session gets.
 *   challenge    at most one per round and two per session, each filled field
 *                at most once per session: allowed when the frontier holds
 *                fewer fields than the cap at depth 4 or 5, or when the
 *                frontier is empty at depth 5. A challenge never displaces a
 *                frontier field.
 *                Phase 4.2 (D28): a "grill me on what changed" session sets
 *                `challengeAlways` (its stale fields are filled, and challenging
 *                them is the session's purpose) and its own `challengesMax`
 *                (one per stale field, bounded): still one a round, each field
 *                once.
 *   assignments  with one persona (or none) every target is its; with several,
 *                targets are dealt round-robin in frontier order starting at
 *                the persona whose index is `(roundNumber - 1) mod personas`, so
 *                each leads in turn and the deal is deterministic. Each field
 *                is asked once per round by exactly one persona.
 */
import { roundCapFor } from './dials';
import { refKey, type FieldRef, type FrontierEntry } from './frontier';
import type { TargetCandidate } from './generators';
import type { QuestionGeneratorKey } from './vocabulary';

/** At most this many challenges in a session, each filled field at most once. */
export const CHALLENGES_PER_SESSION = 2;

export interface PlanInput {
    frontier: readonly FrontierEntry[];
    /** Filled fields (by the bible's own values) within the depth, in frontier order. */
    challengeable: readonly (FieldRef & { level: number })[];
    /** Fields already challenged, and how many challenges were planned so far, in this session. */
    challenged: readonly FieldRef[];
    challengesPlanned: number;
    depth: number;
    detail: number;
    /** The session's personas; empty when it mounts none. */
    personaKeys: readonly string[];
    roundNumber: number;
    /** Phase 4.2: a session's own challenge limit (default `CHALLENGES_PER_SESSION`). */
    challengesMax?: number;
    /** Phase 4.2: challenge whatever the frontier holds (a grill session on what changed). */
    challengeAlways?: boolean;
    /** Phase 4.4: the frontier's own size, when `frontier` holds only the round's chosen model-worded targets (the challenge rule reads it). */
    frontierSize?: number;
    /** Phase 4.4: false when the round has no room for a challenge at all (a QUESTIONS session's last questions). Default true. */
    allowChallenge?: boolean;
}

export interface PlannedTarget extends FrontierEntry {
    personaKey: string | null;
    /** Phase 4.4 (D30): the generator that proposed it (the frontier, or relations for a relation's empty field) and its value score. */
    generator?: QuestionGeneratorKey;
    value?: number;
}

/** Phase 4.4: a candidate code worded (a ladder layer, a pair, a source fact, a continuity item), held in memory only. */
export type WordedTarget = TargetCandidate & { worded: NonNullable<TargetCandidate['worded']> };

export interface RoundPlan {
    cap: number;
    targets: PlannedTarget[];
    /** Frontier fields beyond the cap, asked next round. */
    carried: FrontierEntry[];
    challenge: (FieldRef & { level: number; personaKey: string | null }) | null;
    /**
     * Phase 4.4 (D30): the round's code-worded candidates. In memory only: the stored plan names them by id and field,
     * never their text (author words are quoted in them).
     */
    worded?: WordedTarget[];
    /** Phase 4.4 (D30): every chosen candidate's place, best value first (and after the tie-break): `candidateKey`. */
    rank?: ReadonlyMap<string, number>;
}

/** A candidate's key in a round's `rank`: its field reference, or a fact's id for a source question with no field. */
export function candidateKey(c: { elementId: string; fieldKey: string | null; storyFactId?: string }): string {
    return c.fieldKey !== null ? refKey({ elementId: c.elementId, fieldKey: c.fieldKey }) : `fact\u0000${c.storyFactId ?? ''}`;
}

export function challengeAllowed(frontierSize: number, cap: number, depth: number): boolean {
    return (depth >= 4 && frontierSize < cap) || (frontierSize === 0 && depth === 5);
}

export function planRound(input: PlanInput): RoundPlan {
    const cap = roundCapFor(input.detail);
    const targets = input.frontier.slice(0, cap);
    const carried = input.frontier.slice(cap);
    const personas = input.personaKeys;
    const lead = personas.length === 0 ? 0 : (((input.roundNumber - 1) % personas.length) + personas.length) % personas.length;
    const personaAt = (i: number): string | null => (personas.length === 0 ? null : personas[(lead + i) % personas.length]);

    let challenge: RoundPlan['challenge'] = null;
    const limit = input.challengesMax ?? CHALLENGES_PER_SESSION;
    if (input.allowChallenge !== false && input.challengesPlanned < limit && (input.challengeAlways || challengeAllowed(input.frontierSize ?? input.frontier.length, cap, input.depth))) {
        const done = new Set(input.challenged.map(refKey));
        const next = input.challengeable.find((r) => r.level <= input.depth && !done.has(refKey(r)));
        if (next) challenge = { elementId: next.elementId, fieldKey: next.fieldKey, level: next.level, personaKey: personaAt(0) };
    }

    return {
        cap,
        targets: targets.map((t, i) => ({ ...t, personaKey: personaAt(i) })),
        carried: [...carried],
        challenge,
    };
}
