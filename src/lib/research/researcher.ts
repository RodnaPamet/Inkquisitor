/**
 * The research run's model steps behind one interface (Phase 2.6), so the
 * product, the evaluation and the tests drive the same `runResearchSteps`
 * (`./run.ts`):
 *
 *   gather    the server-tool turn: searches and fetches, the pages read
 *   findings  one structured call over the sources
 *   fit       one structured call over the findings and the scope
 *
 * The product's researcher is `defaultResearcher(ctx)` (`./model-seam.ts`,
 * THE wiring to 2.1). The evaluation's deterministic researcher answers from a
 * case's fake web (`./evals/evaluation.ts`). Each step returns its output, or
 * a named failure with what it cost: nothing is ever invented in place of a
 * failed call.
 */
import type { AuthorDataBlock } from '@/lib/ai/prompt';
import type { FetchedDocument, SearchCall, ServerToolLoopStop, ToolUseSeen, WebToolsSpec } from '@/lib/ai/server-tool-loop';
import type { ResearchOutcome } from './vocabulary';

/** The failures a step can end in (the run's outcome for each). */
export type StepFailure = Extract<
    ResearchOutcome,
    'GUARD_REFUSED' | 'QUERY_REFUSED' | 'TIMEOUT' | 'ABORTED' | 'PROVIDER_FAILURE' | 'INVALID_OUTPUT' | 'KILL_SWITCH' | 'WORKSPACE_CEILING' | 'PROMPT_INVALID' | 'AI_UNAVAILABLE'
>;

export interface StepCost {
    readonly tokensUsed: number;
    readonly costMicroUsd: number;
    readonly callIds: readonly string[];
    readonly reviewRequired?: boolean;
    readonly guardRuleIds?: readonly string[];
}

export interface GatherRequest {
    readonly data: readonly AuthorDataBlock[];
    readonly tools: WebToolsSpec;
    readonly maxRequests: number;
    readonly budgetMicroUsd: number;
    /** The egress tripwire (`query-egress.ts`): a refusal stops the run QUERY_REFUSED. */
    readonly inspectToolUse: (use: ToolUseSeen) => string | null;
    readonly bookId: string;
}

export interface GatherOutput extends StepCost {
    readonly stop: ServerToolLoopStop;
    readonly searches: readonly SearchCall[];
    readonly fetches: readonly FetchedDocument[];
    readonly requests: number;
}

export type StepResult<T> = ({ ok: true; output: T } & StepCost) | ({ ok: false; failure: StepFailure; errorCode: string } & StepCost);

export interface StructuredStepRequest {
    readonly data: readonly AuthorDataBlock[];
    readonly bookId: string;
}

/** What the run observes as a step goes (counts only). */
export interface GatherObserver {
    readonly onToolUse?: (counts: { searches: number; fetches: number }) => void;
}

export interface Researcher {
    gather(request: GatherRequest, observer: GatherObserver, signal?: AbortSignal): Promise<{ ok: true; output: GatherOutput } | ({ ok: false; failure: StepFailure; errorCode: string } & StepCost)>;
    findings(request: StructuredStepRequest, signal?: AbortSignal): Promise<StepResult<unknown>>;
    fit(request: StructuredStepRequest, signal?: AbortSignal): Promise<StepResult<unknown>>;
}
