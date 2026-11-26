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
}

export interface PlannedTarget extends FrontierEntry {
    personaKey: string | null;
}

export interface RoundPlan {
    cap: number;
    targets: PlannedTarget[];
    /** Frontier fields beyond the cap, asked next round. */
    carried: FrontierEntry[];
    challenge: (FieldRef & { level: number; personaKey: string | null }) | null;
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
    if (input.challengesPlanned < limit && (input.challengeAlways || challengeAllowed(input.frontier.length, cap, input.depth))) {
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
