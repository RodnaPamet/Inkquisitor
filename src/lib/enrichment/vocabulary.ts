/**
 * The closed lists of enrichment (Phase 2.5), client-safe: no imports.
 *
 *   RECONCILE_OPS         what a reconcile step may answer for one field (the
 *                         mem0 reconciliation pattern, Apache-2.0): ADD into
 *                         an empty field, UPDATE or REMOVE a filled one, or
 *                         NO_CHANGE. NO_CHANGE writes nothing and is never
 *                         stored; the other three are `EnrichmentOperation`.
 *   PROPOSAL_STATUSES     mirrors `EnrichmentProposalStatus`.
 *   RECONCILE_OUTCOMES    how a run ended; mirrored by the CHECK
 *                         `ReconcileRun_outcome_known` in the 2.5 migration.
 *   REFUSAL_CODES         why code refused one proposal the model made
 *                         (`validate.ts`). Counted on the run, never stored as
 *                         a row: a refused proposal is never shown.
 */

export const RECONCILE_OPS = ['ADD', 'UPDATE', 'REMOVE', 'NO_CHANGE'] as const;
export type ReconcileOp = (typeof RECONCILE_OPS)[number];

/** The operations a stored proposal carries (NO_CHANGE writes nothing). */
export const STORED_OPS = ['ADD', 'UPDATE', 'REMOVE'] as const;
export type StoredOp = (typeof STORED_OPS)[number];

export const PROPOSAL_KINDS = ['FIELD', 'NEW_ELEMENT'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_STATUSES = ['PENDING', 'ACCEPTED', 'EDITED_ACCEPTED', 'REJECTED', 'SUPERSEDED'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const RECONCILE_RUN_STATUSES = ['RUNNING', 'DONE', 'FAILED', 'REFUSED'] as const;
export type ReconcileRunStatus = (typeof RECONCILE_RUN_STATUSES)[number];

/**
 * How a reconcile run ended (`ReconcileRun.outcome`).
 *
 *   OK                        DONE: the call answered; its valid proposals are stored (none is an answer too)
 *   NOTHING_TO_RECONCILE      DONE: the round has no ANSWERED answer, so no call was made
 *   GUARD_REFUSED             FAILED: 2.1's guard refused the call or withheld its answer
 *   TIMEOUT                   FAILED: the tier's deadline passed
 *   ABORTED                   FAILED: the request was cancelled
 *   PROVIDER_FAILURE          FAILED: the provider failed or declined (HTTP, connection, a model refusal)
 *   INVALID_OUTPUT            FAILED: the answer was invalid after 2.1's one repair, cut off or empty
 *   KILL_SWITCH               FAILED: `AI_DISABLED=1`; nothing was sent
 *   WORKSPACE_CEILING         FAILED: the workspace's monthly ceiling; nothing was sent
 *   PROMPT_INVALID            FAILED: 2.1 refused to build the prompt (a programming error)
 *   CLAIM_EXPIRED             FAILED: the process running it died; the next request found the claim stale
 *   AI_UNAVAILABLE            REFUSED: no model call can be made under this deployment's configuration
 *   RECONCILE_NOT_EVALUATED   REFUSED: the reconcile prompt has no evaluation record this deployment accepts (D11)
 *
 * A FAILED or REFUSED run may be run again; nothing is ever proposed from a
 * failed call (design 10.2: no partial output).
 */
export const RECONCILE_OUTCOMES = [
    'OK',
    'NOTHING_TO_RECONCILE',
    'GUARD_REFUSED',
    'TIMEOUT',
    'ABORTED',
    'PROVIDER_FAILURE',
    'INVALID_OUTPUT',
    'KILL_SWITCH',
    'WORKSPACE_CEILING',
    'PROMPT_INVALID',
    'AI_UNAVAILABLE',
    'RECONCILE_NOT_EVALUATED',
    'CLAIM_EXPIRED',
] as const;
export type ReconcileOutcome = (typeof RECONCILE_OUTCOMES)[number];

export const DONE_OUTCOMES: readonly ReconcileOutcome[] = ['OK', 'NOTHING_TO_RECONCILE'];
export const REFUSED_OUTCOMES: readonly ReconcileOutcome[] = ['AI_UNAVAILABLE', 'RECONCILE_NOT_EVALUATED'];

/** The run status an outcome ends in. */
export function statusOfOutcome(outcome: ReconcileOutcome): Exclude<ReconcileRunStatus, 'RUNNING'> {
    if (DONE_OUTCOMES.includes(outcome)) return 'DONE';
    if (REFUSED_OUTCOMES.includes(outcome)) return 'REFUSED';
    return 'FAILED';
}

/**
 * Why code refused one proposal (`validate.ts`), first failure wins, in the
 * order the rules run (design section 9, extended):
 *
 *   MALFORMED                  the item did not parse against the output schema
 *   TARGETS_OUT_OF_SCOPE_FIELD the element or field is not one the round targeted
 *   DUPLICATE_TARGET           a second operation on a field already given one
 *   ADD_INTO_FILLED_FIELD      ADD where the field holds a value
 *   CHANGE_OF_EMPTY_FIELD      UPDATE or REMOVE where the field is empty
 *   CITES_NO_ANSWER            ADD, UPDATE or REMOVE (or a new element) citing nothing (rule 2)
 *   CITES_FOREIGN_ANSWER       an id that is not one of the answers this run was given
 *                              (another session's, another round's, an old revision, made up)
 *   CITES_UNANSWERED           an answer the author skipped or left for later
 *   REMOVE_CARRIES_VALUE       a REMOVE with a value
 *   VALUE_MISSING              an ADD or UPDATE with no value (or one that sanitises to nothing)
 *   VALUE_INVALID              a value of the wrong type or past the field's bounds
 *   CHANGES_NOTHING            an UPDATE to the value the field already holds
 *   COPIES_INJECTED_TEXT       markup, a URL no clean cited answer gave, or text the guard flags
 *   UNSOURCED_SENTENCE         a sentence (list item, choice, scale) the cited answers, or for
 *                              an UPDATE the stored value, do not support (rule 2: refused, not softened)
 *   KIND_NOT_PROPOSABLE        a new element of a kind that cannot be proposed (CUSTOM)
 *   NAME_INVALID               a new element's name empty or too long once sanitised
 *   NAME_NOT_IN_ANSWERS        a new element no cited answer names (the model invented it)
 *   ELEMENT_EXISTS             a new element the book already has, by name
 *   DUPLICATE_NEW_ELEMENT      a second proposal of one new element in the same answer
 *   ALREADY_PROPOSED           a new element a pending proposal of the book already offers
 */
export const REFUSAL_CODES = [
    'MALFORMED',
    'TARGETS_OUT_OF_SCOPE_FIELD',
    'DUPLICATE_TARGET',
    'ADD_INTO_FILLED_FIELD',
    'CHANGE_OF_EMPTY_FIELD',
    'CITES_NO_ANSWER',
    'CITES_FOREIGN_ANSWER',
    'CITES_UNANSWERED',
    'REMOVE_CARRIES_VALUE',
    'VALUE_MISSING',
    'VALUE_INVALID',
    'CHANGES_NOTHING',
    'COPIES_INJECTED_TEXT',
    'UNSOURCED_SENTENCE',
    'KIND_NOT_PROPOSABLE',
    'NAME_INVALID',
    'NAME_NOT_IN_ANSWERS',
    'ELEMENT_EXISTS',
    'DUPLICATE_NEW_ELEMENT',
    'ALREADY_PROPOSED',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/**
 * Why an acceptance (or a rejection) was refused, as `details.reason` (the
 * review UI words each from `enrichment.errors`).
 */
export const DECISION_REFUSALS = [
    'PROPOSAL_DECIDED',
    'VERSION_CONFLICT',
    'PROPOSAL_OUTDATED',
    'PROPOSAL_STALE',
    'EDIT_NOT_ALLOWED',
    'EDIT_CHANGES_NOTHING',
    'FIELD_VALUES_REFUSED',
    'BULK_INELIGIBLE',
    'ELEMENT_EXISTS',
    'CITATIONS_GONE',
] as const;
export type DecisionRefusal = (typeof DECISION_REFUSALS)[number];
