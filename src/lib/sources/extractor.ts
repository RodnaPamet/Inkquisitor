/**
 * What extracting one chunk's facts needs from a model (Phase 4.0): one
 * structured call, behind an interface so the evaluation's replay, the stub
 * and the tests stand in for the deployment's (`model-seam.ts`).
 */
import type { AuthorDataBlock } from '@/lib/ai/prompt';

/** How a call can fail. KILL_SWITCH, WORKSPACE_CEILING and AI_UNAVAILABLE stop the ingestion; the rest are a chunk's own. */
export const EXTRACT_FAILURES = ['KILL_SWITCH', 'WORKSPACE_CEILING', 'AI_UNAVAILABLE', 'GUARD_REFUSED', 'TIMEOUT', 'ABORTED', 'PROVIDER_FAILURE', 'INVALID_OUTPUT', 'PROMPT_INVALID'] as const;
export type ExtractFailure = (typeof EXTRACT_FAILURES)[number];

export interface ExtractCost {
    readonly tokensUsed: number;
    readonly costMicroUsd: number;
    readonly callIds: readonly string[];
}

export type ExtractResult = ({ ok: true; output: unknown } & ExtractCost) | ({ ok: false; failure: ExtractFailure; errorCode: string } & ExtractCost);

export interface ExtractRequest {
    readonly data: readonly AuthorDataBlock[];
    /** The book the call is filed under (`AiCallLog.bookId`); NULL for the series library. */
    readonly bookId: string | null;
}

export interface FactExtractor {
    extract(request: ExtractRequest, signal?: AbortSignal): Promise<ExtractResult>;
}
