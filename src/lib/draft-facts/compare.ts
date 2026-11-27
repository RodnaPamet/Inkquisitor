/**
 * THE DRAFT HELD AGAINST THE BIBLE — the comparison (Phase 5.3, D35). Pure and deterministic.
 *
 * Each live DRAFT fact of a scene is compared with the book's live BIBLE facts by 4.2's rules (`ruleContradiction`,
 * with 4.H-b's precision refusals): the same linked subject element and predicate, and
 *
 *   VALUE        an AGE, OCCUPATION or PLACE_TYPE that plainly differs at an overlapping story time (eye colour is an
 *                APPEARANCE: a ROLE, a WANT or an APPEARANCE can hold several values, so no rule calls two of them
 *                contradictory — that is the deep check's, which the draft reading does not run in 5.3);
 *   WHEREABOUTS  two LOCATIONs that plainly differ at a time BOTH facts place: someone in the scene who is elsewhere
 *                on the timeline;
 *   KNOWLEDGE    knowing at a point before a point of not knowing: someone knowing what they have not learned yet.
 *
 * Only bible facts (an element's or a relation's accepted version, 4.1) are the other side: a confirmed SOURCE fact is
 * an earlier draft of the author's, never canon over this one, and an author's explanation states no value.
 *
 * WHERE A SCENE STANDS IN STORY TIME (the D25 story clock): a scene linked to exactly ONE placed plot beat (D33) takes
 * that beat's place in the story order; every draft fact of it holds there (`ownerElementId`), as a bible fact holds
 * at its own entry's place. Otherwise its facts carry only text times: the fact's own, else the scene's free-text
 * story time. LIMITS: a scene linked to several beats takes none of them (it may span them); a text time decides an
 * overlap only by equal words (4.1's rule); two facts placed in different orders overlap only by stated times
 * (4.H-b). So a WHEREABOUTS or KNOWLEDGE mismatch needs the scene on the plot board or a stated time.
 *
 * Nothing here writes: the caller PROPOSES (rule 1), each pair once.
 */
import { ruleContradiction, type RuleFact } from '@/lib/continuity/rules';
import { NO_ORDER, type StoryClock } from '@/lib/continuity/story-clock';
import type { ContradictionKind } from '@/lib/continuity/vocabulary';

export interface CompareFact {
    readonly id: string;
    readonly predicate: string;
    readonly subjectElementId: string | null;
    readonly objectLiteral: string | null;
    readonly statement: string;
    readonly storyTimeFrom: string | null;
    readonly storyTimeTo: string | null;
}

export interface SceneTime {
    /** The one placed plot beat the scene dramatises, or null (none, or several). */
    readonly beatElementId: string | null;
    /** The scene's free-text story time, or null. */
    readonly storyTime: string | null;
}

export interface DraftMismatchPair {
    readonly bibleFactId: string;
    readonly draftFactId: string;
    readonly kind: ContradictionKind;
}

/** The one beat a scene takes its place from: exactly one linked beat that the clock places, else none. */
export function sceneBeat(beatIds: readonly string[], clock: StoryClock): string | null {
    const placed = [...new Set(beatIds)].filter((id) => clock.positionOf({ storyTimeFrom: null, storyTimeTo: null, ownerElementId: id }) !== null);
    return placed.length === 1 ? placed[0] : null;
}

/** A draft fact as the rules read it: placed at the scene's beat, or timed by its own words else the scene's. */
export function asDraftRuleFact(f: CompareFact, time: SceneTime): RuleFact {
    const ownTime = (f.storyTimeFrom && f.storyTimeFrom.trim() !== '') || (f.storyTimeTo && f.storyTimeTo.trim() !== '');
    return {
        id: f.id,
        predicate: f.predicate,
        subjectElementId: f.subjectElementId,
        objectLiteral: f.objectLiteral,
        statement: f.statement,
        storyTimeFrom: ownTime ? f.storyTimeFrom : time.storyTime,
        storyTimeTo: ownTime ? f.storyTimeTo : null,
        ownerElementId: time.beatElementId,
    };
}

/**
 * Every (bible fact, draft fact) pair a rule calls contradictory, in draft-fact order. `bible` carries each fact's
 * owner element (its entry's place in the story order). Grouped by subject first, so the work is the sum of each
 * subject's pairs; `maxPairs` bounds it (the rest are counted `cut`).
 */
export function compareDraftWithBible(
    draft: readonly CompareFact[],
    bible: ReadonlyArray<CompareFact & { ownerElementId: string | null }>,
    time: SceneTime,
    clock: StoryClock = NO_ORDER,
    maxPairs = 20_000,
): { pairs: DraftMismatchPair[]; compared: number; cut: number } {
    const bySubject = new Map<string, Array<CompareFact & { ownerElementId: string | null }>>();
    for (const b of bible) {
        if (!b.subjectElementId) continue;
        const list = bySubject.get(b.subjectElementId);
        if (list) list.push(b);
        else bySubject.set(b.subjectElementId, [b]);
    }
    const pairs: DraftMismatchPair[] = [];
    let compared = 0;
    let cut = 0;
    for (const d of draft) {
        if (!d.subjectElementId) continue;
        const ruleDraft = asDraftRuleFact(d, time);
        for (const b of bySubject.get(d.subjectElementId) ?? []) {
            if (b.predicate !== d.predicate) continue;
            if (compared >= maxPairs) {
                cut++;
                continue;
            }
            compared++;
            const kind = ruleContradiction({ ...b, id: b.id }, ruleDraft, clock);
            if (kind) pairs.push({ bibleFactId: b.id, draftFactId: d.id, kind });
        }
    }
    return { pairs, compared, cut };
}
