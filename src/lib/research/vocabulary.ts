/**
 * The closed lists of the research agent (Phase 2.6, decision D9), client-safe:
 * no imports.
 *
 *   DEPTH_BUDGETS      what each depth lets a run do: searches, page fetches,
 *                      requests of the gather turn, a soft spend cap, findings
 *   RESEARCH_OUTCOMES  how a run ended; mirrored by the CHECK
 *                      `ResearchRun_outcome_known` in the 2.6 migration
 *   FINDING_REFUSALS   why code refused a finding the agent drafted
 *   FIT_REFUSALS       why code refused a proposal the agent made
 *   PROGRESS_PHASES    where a run is, as its progress stream says
 */

export const RESEARCH_DEPTHS = ['QUICK', 'STANDARD', 'THOROUGH'] as const;
export type ResearchDepth = (typeof RESEARCH_DEPTHS)[number];

export interface DepthBudget {
    /** Web searches across the gather turn (the tool's `max_uses`; the API enforces it across continuations). */
    readonly searches: number;
    /** Pages fetched across the gather turn (the fetch tool's `max_uses`). */
    readonly fetches: number;
    /** Requests of the gather turn: the first and its `pause_turn` continuations. */
    readonly requests: number;
    /**
     * A SOFT spend cap for the gather turn, micro-dollars: no further request
     * is sent once the turn has cost this much. The monthly ceiling is the
     * hard gate (every request reserves its worst case against it).
     */
    readonly gatherSpendMicroUsd: number;
    /** Findings kept at most. */
    readonly findings: number;
}

/**
 * The step and spend budget each depth sets (the roadmap's "a depth that sets
 * the step and spend budget"). Quick answers one narrow question from a few
 * pages; thorough reads widely. A change here is a product decision a review
 * reads.
 */
export const DEPTH_BUDGETS: Readonly<Record<ResearchDepth, DepthBudget>> = {
    QUICK: { searches: 3, fetches: 4, requests: 2, gatherSpendMicroUsd: 400_000, findings: 6 },
    STANDARD: { searches: 6, fetches: 8, requests: 4, gatherSpendMicroUsd: 1_000_000, findings: 10 },
    THOROUGH: { searches: 12, fetches: 16, requests: 6, gatherSpendMicroUsd: 2_500_000, findings: 16 },
};

/** Each fetched page's text is cut at this many tokens by the fetch tool itself (`max_content_tokens`). */
export const FETCH_MAX_CONTENT_TOKENS = 8_000;

export const BRIEF_STATUSES = ['READY', 'QUEUED', 'RUNNING', 'DONE', 'FAILED', 'REFUSED'] as const;
export type ResearchBriefStatus = (typeof BRIEF_STATUSES)[number];

export const RUN_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'REFUSED'] as const;
export type ResearchRunStatus = (typeof RUN_STATUSES)[number];

/**
 * How a run ended (`ResearchRun.outcome`).
 *
 *   OK                       DONE: at least one verified finding is stored (proposals or none)
 *   NO_SOURCES               DONE: nothing could be read — no page came back as text and no file is attached
 *   NO_FINDINGS              DONE: sources were read and the agent drafted no claim from them
 *   ALL_REFUSED              DONE: claims were drafted and code refused every one (an unverifiable quote, an unsourced sentence, …)
 *   BUDGET_SPENT             DONE: the depth's budget was spent before anything could be read
 *   GUARD_REFUSED            FAILED: 2.1's guard refused a call or withheld its answer
 *   QUERY_REFUSED            FAILED: a search query or fetch URL quoted the book's stored text; the run stopped (the egress tripwire)
 *   TIMEOUT                  FAILED: a call passed its tier's deadline
 *   ABORTED                  FAILED: the run was cancelled
 *   PROVIDER_FAILURE         FAILED: the provider failed or declined
 *   INVALID_OUTPUT           FAILED: a structured answer was invalid after 2.1's one repair, cut off or empty
 *   KILL_SWITCH              FAILED: `AI_DISABLED=1`; nothing more was sent
 *   WORKSPACE_CEILING        FAILED: the workspace's monthly ceiling; nothing more was sent
 *   PROMPT_INVALID           FAILED: 2.1 refused to build a prompt (a programming error)
 *   CLAIM_EXPIRED            FAILED: the worker running it died; a later read found the claim stale
 *   INTERNAL                 FAILED: something else broke in the worker (logged)
 *   AI_UNAVAILABLE           REFUSED: no model call can be made under this deployment's configuration
 *   RESEARCH_NOT_EVALUATED   REFUSED: the research prompts have no evaluation record this deployment accepts (D11)
 *   BRIEF_QUOTES_BIBLE       REFUSED: the brief's question, purpose or a URL quotes the book's stored text (D9)
 *   REQUESTER_NOT_PERMITTED  REFUSED: the person who dispatched it may no longer edit the bible
 *
 * Every FAILED and REFUSED run may be run again (a new run of the brief).
 */
export const RESEARCH_OUTCOMES = [
    'OK',
    'NO_SOURCES',
    'NO_FINDINGS',
    'ALL_REFUSED',
    'BUDGET_SPENT',
    'GUARD_REFUSED',
    'QUERY_REFUSED',
    'TIMEOUT',
    'ABORTED',
    'PROVIDER_FAILURE',
    'INVALID_OUTPUT',
    'KILL_SWITCH',
    'WORKSPACE_CEILING',
    'PROMPT_INVALID',
    'CLAIM_EXPIRED',
    'INTERNAL',
    'AI_UNAVAILABLE',
    'RESEARCH_NOT_EVALUATED',
    'BRIEF_QUOTES_BIBLE',
    'REQUESTER_NOT_PERMITTED',
] as const;
export type ResearchOutcome = (typeof RESEARCH_OUTCOMES)[number];

/** The outcomes that end a run DONE: it ran to the end; zero findings is a named reason, never "complete" (rule 6). */
export const DONE_OUTCOMES: readonly ResearchOutcome[] = ['OK', 'NO_SOURCES', 'NO_FINDINGS', 'ALL_REFUSED', 'BUDGET_SPENT'];
/** The outcomes that end a run REFUSED: nothing was sent. */
export const REFUSED_OUTCOMES: readonly ResearchOutcome[] = ['AI_UNAVAILABLE', 'RESEARCH_NOT_EVALUATED', 'BRIEF_QUOTES_BIBLE', 'REQUESTER_NOT_PERMITTED'];

export function statusOfOutcome(outcome: ResearchOutcome): Exclude<ResearchRunStatus, 'QUEUED' | 'RUNNING'> {
    if (DONE_OUTCOMES.includes(outcome)) return 'DONE';
    if (REFUSED_OUTCOMES.includes(outcome)) return 'REFUSED';
    return 'FAILED';
}

/** A RUNNING run older than this is a claim whose worker died; it reads as FAILED CLAIM_EXPIRED. */
export const STALE_RUN_MS = 30 * 60_000;

/** How a run reads: its stored state, except a stale RUNNING (or long-QUEUED) one, which nothing will finish. */
export function effectiveRunState(
    run: { status: ResearchRunStatus; outcome: string | null; startedAt: Date | null; createdAt: Date },
    now: number = Date.now(),
): { status: ResearchRunStatus; outcome: ResearchOutcome | null } {
    const since = (run.startedAt ?? run.createdAt).getTime();
    if ((run.status === 'RUNNING' || run.status === 'QUEUED') && now - since >= STALE_RUN_MS) return { status: 'FAILED', outcome: 'CLAIM_EXPIRED' };
    return { status: run.status, outcome: (run.outcome as ResearchOutcome | null) ?? null };
}

export const CONFIDENCES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type ResearchConfidence = (typeof CONFIDENCES)[number];

export const RESEARCH_OPS = ['ADD', 'UPDATE', 'NEW_ELEMENT'] as const;
export type ResearchOp = (typeof RESEARCH_OPS)[number];

/** What a stored proposal warns the author of (D14): its text addresses the product itself. */
export const RESEARCH_PROPOSAL_FLAGS = ['POSSIBLE_INSTRUCTION'] as const;
export type ResearchProposalFlag = (typeof RESEARCH_PROPOSAL_FLAGS)[number];

/**
 * Why code refused a drafted finding (first failure wins):
 *
 *   MALFORMED              the item did not parse against the output schema
 *   CLAIM_EMPTY            the claim (or the summary) sanitises to nothing
 *   CITES_NO_SOURCE        no citation at all (rule 2)
 *   CITES_UNKNOWN_SOURCE   a citation names a source the run did not read
 *   QUOTE_TOO_SHORT        a quote under the minimum, which could match anywhere
 *   QUOTE_NOT_IN_SOURCE    a quote that does not appear in the source's retrieved text (unverifiable)
 *   QUOTE_FLAGGED          a quote that carries an instruction to the model (the guard flags it): no evidence
 *   CLAIM_UNSOURCED        a sentence of the claim the cited sources do not support
 *   SUMMARY_UNSOURCED      a sentence of the summary the cited sources do not support
 *   COPIES_INJECTED_TEXT   markup, a script scheme, a URL the sources do not give, or text the guard flags
 *   DUPLICATE_CLAIM        the same claim twice in one answer
 *   OVER_LIMIT             past the depth's number of findings
 */
export const FINDING_REFUSALS = [
    'MALFORMED',
    'CLAIM_EMPTY',
    'CITES_NO_SOURCE',
    'CITES_UNKNOWN_SOURCE',
    'QUOTE_TOO_SHORT',
    'QUOTE_NOT_IN_SOURCE',
    'QUOTE_FLAGGED',
    'CLAIM_UNSOURCED',
    'SUMMARY_UNSOURCED',
    'COPIES_INJECTED_TEXT',
    'DUPLICATE_CLAIM',
    'OVER_LIMIT',
] as const;
export type FindingRefusal = (typeof FINDING_REFUSALS)[number];

/**
 * Why code refused a proposal of the fit step (first failure wins):
 *
 *   MALFORMED              the item did not parse against the output schema
 *   CITES_NO_FINDING       no finding cited (rule 2)
 *   CITES_UNKNOWN_FINDING  a finding this run did not keep
 *   TARGETS_OUTSIDE_SCOPE  an element that is not a scope element or a related one (or outside the book);
 *                          an UPDATE of a related element (its values were never shown)
 *   FIELD_NOT_IN_TEMPLATE  a field the element's template lacks
 *   DUPLICATE_TARGET       a second proposal for one field
 *   ADD_INTO_FILLED_FIELD  ADD where the field holds a value
 *   UPDATE_OF_EMPTY_FIELD  UPDATE where the field is empty
 *   VALUE_MISSING          no value, or one that sanitises to nothing
 *   VALUE_INVALID          a value the field's type refuses
 *   CHANGES_NOTHING        an UPDATE to the value the field holds
 *   UNSOURCED_SENTENCE     a sentence the cited findings (and, for an UPDATE, the stored value) do not support
 *   WRITES_PROSE           quoted speech the findings do not hold: a scene or dialogue (D3)
 *   COPIES_INJECTED_TEXT   markup, a script scheme, a URL the findings do not give, or text the guard flags
 *   RATIONALE_MISSING      no reason given for how the findings bear on it
 *   KIND_NOT_PROPOSABLE    a new element of a kind that cannot be proposed (CUSTOM)
 *   NAME_INVALID           a new element's name empty or too long once sanitised
 *   NAME_NOT_IN_FINDINGS   a new element no cited finding names
 *   ELEMENT_EXISTS         a new element the book already holds, by name
 *   DUPLICATE_NEW_ELEMENT  a second proposal of one new element
 *   NO_FIT_UNKNOWN_FINDING a "no fit" naming a finding this run did not keep
 */
export const FIT_REFUSALS = [
    'MALFORMED',
    'CITES_NO_FINDING',
    'CITES_UNKNOWN_FINDING',
    'TARGETS_OUTSIDE_SCOPE',
    'FIELD_NOT_IN_TEMPLATE',
    'DUPLICATE_TARGET',
    'ADD_INTO_FILLED_FIELD',
    'UPDATE_OF_EMPTY_FIELD',
    'VALUE_MISSING',
    'VALUE_INVALID',
    'CHANGES_NOTHING',
    'UNSOURCED_SENTENCE',
    'WRITES_PROSE',
    'COPIES_INJECTED_TEXT',
    'RATIONALE_MISSING',
    'KIND_NOT_PROPOSABLE',
    'NAME_INVALID',
    'NAME_NOT_IN_FINDINGS',
    'ELEMENT_EXISTS',
    'DUPLICATE_NEW_ELEMENT',
    'NO_FIT_UNKNOWN_FINDING',
] as const;
export type FitRefusal = (typeof FIT_REFUSALS)[number];

/** Where a run is, as the progress stream reports it (counts beside it, never text). */
export const PROGRESS_PHASES = ['queued', 'searching', 'reading', 'drafting_findings', 'fitting', 'saving', 'finished'] as const;
export type ProgressPhase = (typeof PROGRESS_PHASES)[number];

export interface RunProgress {
    readonly phase: ProgressPhase;
    readonly searches: number;
    readonly fetches: number;
    readonly sources: number;
    readonly findings: number;
    readonly proposals: number;
}

export const EMPTY_PROGRESS: RunProgress = { phase: 'queued', searches: 0, fetches: 0, sources: 0, findings: 0, proposals: 0 };

/**
 * Why a decision on a research proposal (or keeping a finding) was refused, as
 * `details.reason` (the page words each from `research.errors`).
 */
export const RESEARCH_DECISION_REFUSALS = [
    'PROPOSAL_DECIDED',
    'VERSION_CONFLICT',
    'PROPOSAL_OUTDATED',
    'PROPOSAL_STALE',
    'EDIT_NOT_ALLOWED',
    'EDIT_CHANGES_NOTHING',
    'ELEMENT_EXISTS',
    'FINDING_KEPT',
] as const;

/** Why writing or running a brief was refused, as `details.reason`. */
export const BRIEF_REFUSALS = [
    'BRIEF_QUOTES_BIBLE',
    'SCOPE_ELEMENT_NOT_IN_BOOK',
    'URL_INVALID',
    'RUN_IN_PROGRESS',
    'SOURCE_TYPE',
    'SOURCE_NOT_TEXT',
    'SOURCE_EMPTY',
    'SOURCES_FULL',
    'UPLOAD_INFECTED',
    'SCAN_UNAVAILABLE',
    'AI_UNAVAILABLE',
    'RESEARCH_NOT_EVALUATED',
] as const;
