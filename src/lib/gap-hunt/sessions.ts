/**
 * THE NEXT THREE SESSIONS a gap hunt proposes (Phase 4.3, D29): each pick, in
 * its order, as a ready-to-start scoped interview the existing start route
 * takes. Client-safe and pure.
 *
 *   one empty element   an ELEMENT session on it
 *   several             a KIND session on the kind
 *   depth               at least the field's level, so the gap is on the frontier; at least `minDepth`
 *
 * Two picks that would start the same session make one; three distinct ones are proposed at most.
 */
import type { InterviewTarget } from '@/lib/interview/setup';
import { GAP_SESSIONS_PROPOSED, type GapCandidate, type GapPick } from './vocabulary';

export interface ProposedSession {
    /** The candidate it answers (its number). */
    readonly n: number;
    readonly target: InterviewTarget;
    readonly depth: number;
}

export function proposedSessions(picks: readonly GapPick[], candidates: readonly GapCandidate[], minDepth: number): ProposedSession[] {
    const byN = new Map(candidates.map((c) => [c.n, c] as const));
    const out: ProposedSession[] = [];
    const seen = new Set<string>();
    for (const p of picks) {
        const c = byN.get(p.n);
        if (!c) continue;
        const target: InterviewTarget = c.emptyElementIds.length === 1 && c.empty === 1 ? { scope: 'ELEMENT', elementId: c.emptyElementIds[0] } : { scope: 'KIND', kind: c.kind as Extract<InterviewTarget, { scope: 'KIND' }>['kind'] };
        const key = target.scope === 'ELEMENT' ? `e:${target.elementId}` : `k:${target.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ n: c.n, target, depth: Math.min(5, Math.max(minDepth, c.level)) });
        if (out.length >= GAP_SESSIONS_PROPOSED) break;
    }
    return out;
}
