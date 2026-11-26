/**
 * The gap hunt's words and bounds (Phase 4.3, decision D29). Client-safe: no
 * server import, so the Interrogate page reads the same lists the server
 * enforces.
 *
 *   CANDIDATES  computed by CODE, deterministically: every (kind, field) of a
 *               kind the book holds, scored by how much the rest of the book
 *               depends on it (the template's `dependsOn`, transitively; the
 *               kind's relations, citations and facts) and how empty it is
 *               (`candidates.ts`). The top `GAP_CANDIDATES_MAX`.
 *   RANKING     a model call weighs which of THOSE candidates matter most for
 *               this story and gives a one-line reason per pick, citing
 *               candidates; code validates every pick (`validate.ts`). When no
 *               call can be made, or none of its picks survives, the code's own
 *               order is shown LABELLED UNRANKED, with the reason — never passed
 *               off as the model's.
 *   SESSIONS    the top three picks, each a ready-to-start scoped interview.
 */

/** Candidates the code proposes at most (the model ranks within them). */
export const GAP_CANDIDATES_MAX = 12;
/** Picks one ranking keeps at most, and the sessions proposed from them. */
export const GAP_PICKS_MAX = 5;
export const GAP_SESSIONS_PROPOSED = 3;
/** A pick's reason, stored bound (one line). */
export const GAP_REASON_MAX = 200;
/** A pick cites at most this many candidates. */
export const GAP_CITES_MAX = 4;
/** Elements a gap hunt reads at most (a larger book is read in part, and says so). */
export const GAP_ELEMENTS_READ_MAX = 200;
/** Empty elements a candidate remembers by id at most (what an ELEMENT session is started on). */
export const GAP_EMPTY_IDS_KEPT = 20;
/** Gap hunts a book keeps at most (retention: older ones are deleted as a new one is stored; only the newest is read). */
export const GAP_HUNTS_LISTED_MAX = 5;

/** Why a gap hunt's order is the code's own (the migration's CHECK holds the same list). */
export const GAP_UNRANKED_REASONS = [
    'KILL_SWITCH',
    'AI_UNAVAILABLE',
    'WORKSPACE_CEILING',
    'NOT_EVALUATED',
    'CALL_OVER_BUDGET',
    'MODEL_RATE_LIMITED',
    'CALL_FAILED',
    'GUARD_REFUSED',
    'NO_VALID_PICK',
] as const;
export type GapUnrankedReason = (typeof GAP_UNRANKED_REASONS)[number];

/** Refusal codes of the ranking's validation (counted, never rows). */
export const GAP_PICK_REFUSALS = ['INVALID_ITEM', 'OVER_LIMIT', 'UNKNOWN_CANDIDATE', 'DUPLICATE', 'NO_CITATION', 'UNKNOWN_CITATION', 'NOT_GROUNDED', 'REASON_EMPTY', 'COPIES_INJECTED'] as const;
export type GapPickRefusal = (typeof GAP_PICK_REFUSALS)[number];

/** One candidate as stored and shown: product words (kind and field labels) and counts, never author text. */
export interface GapCandidate {
    /** 1-based, the number the model cites (`c1` … in the prompt). */
    readonly n: number;
    readonly kind: string;
    readonly kindLabel: string;
    readonly fieldKey: string;
    readonly fieldLabel: string;
    readonly required: boolean;
    /** The field's depth level in its template (a session asks it from this depth). */
    readonly level: number;
    readonly elements: number;
    readonly empty: number;
    /** Fields of the template that depend on it, directly or through others. */
    readonly dependents: number;
    readonly relations: number;
    readonly facts: number;
    readonly citations: number;
    readonly score: number;
    /** The empty elements' ids (at most `GAP_EMPTY_IDS_KEPT`). */
    readonly emptyElementIds: readonly string[];
}

/** A ranked pick: a candidate, its reason (author-derived text: encrypted at rest) and what it cites. */
export interface GapPick {
    readonly n: number;
    readonly reason: string | null;
    readonly cites: readonly number[];
    readonly flags: readonly string[];
}
