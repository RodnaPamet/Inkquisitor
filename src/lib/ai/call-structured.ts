/**
 * callStructured — ONE streamed model call that returns a Zod-validated object
 * (Phase 2.1).
 *
 * New for Inkquisitor. Every model feature calls this (through
 * `src/app-layer/usecases/model-calls.ts`, which binds it to a workspace's
 * ledger); nothing else sends a request. The order of a call, and what each
 * refusal leaves behind:
 *
 *    1. build the request          `./prompt.ts`: the template's static system
 *                                  prompt, the fenced data. A malformed
 *                                  template is a programming error, thrown
 *                                  before anything is recorded.
 *    2. caller already aborted     ABORTED, nothing sent
 *    3. kill switch                AI_DISABLED=1 → KILLED, nothing sent
 *    4. guard the author text      a block → REFUSED_GUARD, nothing sent; a
 *                                  flag → the call proceeds, fenced, and the
 *                                  result says `reviewRequired`; a scanner that
 *                                  throws → REFUSED_GUARD GUARD_UNAVAILABLE
 *    5. a client                   `clientForRun`; none → PROVIDER_ERROR with
 *                                  the configuration's reason, nothing sent
 *    6. reserve the worst case     max input (UTF-8 bytes) and max_tokens at the
 *                                  model's dearest rates, against the month's
 *                                  ceiling; refused → CEILING, nothing sent
 *    7. send, streamed             one deadline (the tier's `timeoutMs`) over
 *                                  the whole call and the SDK's retries; the
 *                                  caller's `signal` cancels it
 *    8. validate                   a refusal → MODEL_REFUSED; cut off
 *                                  (`max_tokens`, the context window) →
 *                                  TRUNCATED; any other stop but an answer's →
 *                                  NO_OUTPUT; none repaired. Then JSON, then
 *                                  the Zod schema. On failure, ONE
 *                                  repair: the validation problems go back as a
 *                                  new turn (no new author text), after the
 *                                  repair's worst case is re-reserved. A second
 *                                  failure → INVALID_OUTPUT
 *    9. guard the answer           the egress scanner; a block → REFUSED_GUARD,
 *                                  the answer is withheld
 *   10. settle                     one `AiCallLog` row, the cost added to the
 *                                  month, the reservation released — on EVERY
 *                                  exit from step 2 on
 *
 * Streaming is used for every call (the SDK's guidance for long outputs and
 * high `max_tokens`); `finalMessage()` assembles the answer. No text is
 * logged: a log line carries the call id, codes, counts and money.
 */
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import type { AiCallRecord, AiLedger } from './call-record';
import { spendPeriod } from './call-record';
import { classifySdkError, clientForRun, jsonSchemaFor } from './client';
import { aiDisabled, monthlyCeilingMicroUsd, type AiEnvRecord } from './config';
import {
    AiCallAbortedError,
    AiGuardBlockedError,
    AiOutputInvalidError,
    AiProviderError,
    AiSpendCeilingError,
    AiTimeoutError,
    AiUnavailableError,
    type AiCallOutcome,
    type AiErrorCode,
    type SafeIssue,
} from './errors';
import { guardAuthorText, guardModelOutput, summariseChecks, type GuardCheck } from './guard';
import { costMicroUsd, worstCaseCostMicroUsd } from './pricing';
import {
    buildModelRequest,
    buildRepairRequest,
    inputTokenBound,
    newFenceNonce,
    OUTPUT_TOOL_NAME,
    resolveCall,
    type AuthorDataBlock,
    type ModelRequest,
    type PromptTemplate,
    type RepairIssue,
} from './prompt';

/** How long a reservation outlives the call's deadline before it stops counting (a dead process's). */
export const RESERVATION_GRACE_MS = 60_000;

export interface StructuredCallInput<S extends z.ZodType> {
    readonly template: Readonly<PromptTemplate>;
    /** The author text the call works on, each block fenced as data. */
    readonly data: readonly AuthorDataBlock[];
    /** The answer's shape. Code: its JSON schema is cached by the API outside zero retention. */
    readonly schema: S;
    readonly bookId?: string | null;
    readonly requestedById?: string | null;
    /** Cancels the call (an author leaving the page). */
    readonly signal?: AbortSignal;
}

export interface StructuredCallDeps {
    readonly ledger: AiLedger;
    /** The switches (`AI_DISABLED`, the ceiling). Default: the process env. */
    readonly env?: AiEnvRecord;
    /** TEST SEAM: the SDK's fetch. No production caller passes it. */
    readonly fetch?: typeof fetch;
    /** TEST SEAM: a shorter deadline than the tier's. */
    readonly timeoutMs?: number;
}

export interface StructuredCallResult<T> {
    readonly callId: string;
    readonly value: T;
    readonly outcome: Extract<AiCallOutcome, 'OK' | 'REPAIRED'>;
    readonly attempts: number;
    /** True when the guard flagged the input or the answer: a person must look before it is applied. */
    readonly reviewRequired: boolean;
    readonly guardRuleIds: readonly string[];
    readonly costMicroUsd: number;
}

interface Usage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function usageOf(u: Anthropic.Usage | undefined | null): Usage | null {
    if (!u) return null;
    return {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    };
}

/** A thrown call's ending: what to record and what to throw. */
class CallEnd extends Error {
    constructor(
        readonly outcome: AiCallOutcome,
        readonly errorCode: AiErrorCode,
        readonly toThrow: (callId: string) => Error,
    ) {
        super(errorCode);
    }
}

/** Zod issues as the record keeps them (path and code) and as the repair turn states them. */
function issuesOf(error: z.ZodError): { safe: SafeIssue[]; repair: RepairIssue[] } {
    const safe: SafeIssue[] = [];
    const repair: RepairIssue[] = [];
    for (const issue of error.issues) {
        const path = issue.path.map((p) => String(p)).join('.');
        safe.push({ path, code: issue.code });
        repair.push({ path, code: issue.code, message: issue.message });
    }
    return { safe, repair };
}

type Candidate = { ok: true; value: unknown } | { ok: false; safe: SafeIssue[]; repair: RepairIssue[] };

/** The answer a message carries, by output mode. */
function candidateOf(message: Anthropic.Message, singleTool: boolean): { candidate: Candidate; toolUseId: string | null } {
    if (singleTool) {
        const call = message.content.find(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === OUTPUT_TOOL_NAME,
        );
        if (!call) {
            const issue = { path: '', code: 'missing_tool_call', message: `call the ${OUTPUT_TOOL_NAME} tool exactly once` };
            return { candidate: { ok: false, safe: [{ path: '', code: issue.code }], repair: [issue] }, toolUseId: null };
        }
        return { candidate: { ok: true, value: call.input }, toolUseId: call.id };
    }
    const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    if (!text.trim()) {
        const issue = { path: '', code: 'missing_answer', message: 'the answer was empty' };
        return { candidate: { ok: false, safe: [{ path: '', code: issue.code }], repair: [issue] }, toolUseId: null };
    }
    try {
        return { candidate: { ok: true, value: JSON.parse(text) as unknown }, toolUseId: null };
    } catch {
        const issue = { path: '', code: 'invalid_json', message: 'the answer was not valid JSON' };
        return { candidate: { ok: false, safe: [{ path: '', code: issue.code }], repair: [issue] }, toolUseId: null };
    }
}

/**
 * The SDK's response content, as the next request's assistant turn: blocks
 * passed back unchanged, except an EMPTY text block, which the API refuses in
 * a turn that is not the last. An answer with no text and no tool call left
 * (nothing, or thinking alone) is no turn at all (`null`): the repair then
 * asks again after the first request's own turns, as a fresh answer.
 */
function asAssistantTurn(message: Anthropic.Message): Anthropic.ContentBlockParam[] | null {
    const content = (message.content as unknown as Anthropic.ContentBlockParam[]).filter(
        (b) => !(b.type === 'text' && b.text === ''),
    );
    return content.some((b) => b.type === 'text' || b.type === 'tool_use') ? content : null;
}

/** The candidate failures that mean the model gave no answer at all, rather than a wrong one. */
const NO_ANSWER_CODES: ReadonlySet<string> = new Set(['missing_answer', 'missing_tool_call']);

/** The ending of an SDK error, given which signal (if any) aborted the call. */
function endingOfSdkError(err: unknown, deadlineHit: boolean, callerAborted: boolean): CallEnd {
    const kind = classifySdkError(err);
    if (kind.kind === 'aborted' || deadlineHit || callerAborted) {
        if (deadlineHit) return new CallEnd('TIMEOUT', 'DEADLINE', (id) => new AiTimeoutError(id));
        if (callerAborted) return new CallEnd('ABORTED', 'CALLER_ABORT', (id) => new AiCallAbortedError(id));
    }
    switch (kind.kind) {
        case 'refused':
            return new CallEnd('PROVIDER_ERROR', 'REQUEST_REFUSED', (id) => new AiProviderError('REQUEST_REFUSED', id));
        case 'api':
            return new CallEnd(
                'PROVIDER_ERROR',
                'PROVIDER_HTTP_ERROR',
                (id) => new AiProviderError('PROVIDER_HTTP_ERROR', id, { status: kind.status, type: kind.type }),
            );
        default:
            return new CallEnd('PROVIDER_ERROR', 'PROVIDER_CONNECTION', (id) => new AiProviderError('PROVIDER_CONNECTION', id));
    }
}

/**
 * THE structured model call. Returns the validated answer, or throws one of
 * the errors of `./errors.ts`; every path from the first check on settles one
 * `AiCallLog` row first.
 */
export async function callStructured<S extends z.ZodType>(
    input: StructuredCallInput<S>,
    deps: StructuredCallDeps,
): Promise<StructuredCallResult<z.infer<S>>> {
    const { template, data, schema } = input;
    const switches = deps.env ?? env;
    const resolved = resolveCall(template);
    const nonce = newFenceNonce(data);
    const firstRequest = buildModelRequest(template, data, resolved, jsonSchemaFor(schema), nonce);
    const singleTool = resolved.mode === 'single_tool';

    const callId = randomUUID();
    const startedAt = new Date();
    const t0 = Date.now();
    const timeoutMs = deps.timeoutMs ?? resolved.timeoutMs;
    const ceiling = monthlyCeilingMicroUsd(switches);

    let attempts = 0;
    let usage: Usage = { ...ZERO_USAGE };
    let spent = 0;
    let costEstimated = false;
    let worstCase = 0;
    const checks: GuardCheck[] = [];

    const settle = async (outcome: AiCallOutcome, errorCode: AiErrorCode | null): Promise<void> => {
        const guard = summariseChecks(checks);
        const record: AiCallRecord = {
            id: callId,
            bookId: input.bookId ?? null,
            requestedById: input.requestedById ?? null,
            purpose: template.purpose,
            promptId: template.id,
            promptVersion: template.version,
            tier: template.tier,
            model: resolved.model,
            outputMode: attempts > 0 ? resolved.mode : null,
            attempts,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            costMicroUsd: spent,
            costEstimated,
            worstCaseMicroUsd: worstCase,
            durationMs: Date.now() - t0,
            outcome,
            errorCode,
            guardRuleIds: guard.ruleIds,
            guardReviewRequired: guard.reviewRequired,
            startedAt,
        };
        await deps.ledger.settle(record);
        // Token COUNTS, named so: the usage object's member names read as content.
        const tokensIn = record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens;
        const tokensOut = record.outputTokens;
        logger.info('ai: call settled', {
            component: 'ai',
            callId,
            purpose: template.purpose,
            promptId: template.id,
            templateVersion: template.version,
            model: resolved.model,
            outcome,
            errorCode,
            attempts,
            tokensIn,
            tokensOut,
            costMicroUsd: spent,
            durationMs: record.durationMs,
            guardRuleIds: guard.ruleIds,
        });
    };

    const end = async (e: CallEnd): Promise<never> => {
        await settle(e.outcome, e.errorCode);
        throw e.toThrow(callId);
    };

    // 2. The caller has already given up.
    if (input.signal?.aborted) return end(new CallEnd('ABORTED', 'CALLER_ABORT', (id) => new AiCallAbortedError(id)));

    // 3. The kill switch: nothing read, nothing sent.
    if (aiDisabled(switches)) {
        return end(new CallEnd('KILLED', 'AI_DISABLED', (id) => new AiUnavailableError('AI_DISABLED', id)));
    }

    // 4. Author text, guard-scanned on the way in. A scanner that throws
    //    fails closed: nothing is sent.
    try {
        checks.push(...guardAuthorText(data, resolved.guardMode));
    } catch {
        return end(new CallEnd('REFUSED_GUARD', 'GUARD_UNAVAILABLE', (id) => new AiGuardBlockedError('input', [], id, true)));
    }
    const inbound = summariseChecks(checks);
    if (inbound.blocked) {
        const ruleIds = inbound.ruleIds;
        return end(new CallEnd('REFUSED_GUARD', 'GUARD_BLOCKED_INPUT', (id) => new AiGuardBlockedError('input', ruleIds, id)));
    }

    // 5. A client, or the configuration's reason there is none.
    const choice = clientForRun({ callId, fetch: deps.fetch, timeoutMs });
    if (!choice.ok) {
        const reason = choice.reason;
        return end(
            new CallEnd(reason === 'AI_DISABLED' ? 'KILLED' : 'PROVIDER_ERROR', reason, (id) => new AiUnavailableError(reason, id)),
        );
    }
    const client = choice.client;

    // 6. Reserve the attempt's worst case (plus what earlier attempts cost).
    const reserve = async (request: ModelRequest): Promise<void> => {
        const attemptWorst = worstCaseCostMicroUsd(resolved.model, {
            inputTokens: inputTokenBound(request),
            outputTokens: request.max_tokens,
        });
        worstCase = spent + attemptWorst;
        const held = await deps.ledger.reserve({
            callId,
            amountMicroUsd: worstCase,
            ceilingMicroUsd: ceiling,
            ttlMs: timeoutMs + RESERVATION_GRACE_MS,
            startedAt,
        });
        if (!held.ok) {
            const details = {
                spentMicroUsd: held.spentMicroUsd,
                reservedMicroUsd: held.reservedMicroUsd,
                worstCaseMicroUsd: worstCase,
                ceilingMicroUsd: held.ceilingMicroUsd,
                period: spendPeriod(startedAt),
            };
            throw new CallEnd('CEILING', 'SPEND_CEILING', (id) => new AiSpendCeilingError(details, id));
        }
    };

    // 7. One deadline over the whole call; the caller's signal cancels it.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;

    const send = async (request: ModelRequest): Promise<Anthropic.Message> => {
        // Cancelled or past the deadline before this attempt left (while its
        // reservation was being written, say): nothing is sent, so nothing
        // more is charged.
        if (signal.aborted) throw endingOfSdkError(null, deadline.signal.aborted, input.signal?.aborted === true);
        attempts += 1;
        const stream = client.messages.stream(request, { signal });
        try {
            const message = await stream.finalMessage();
            const u = usageOf(message.usage) ?? ZERO_USAGE;
            addUsage(u);
            return message;
        } catch (err) {
            const ending = endingOfSdkError(err, deadline.signal.aborted, input.signal?.aborted === true);
            // What the stream reported before it stopped, if anything. A request
            // the provider answered with an error status, or that this process
            // refused, was not billed. Otherwise (cut off by the deadline, the
            // caller or the connection before any usage arrived) the request may
            // have been processed: its input's worst case is charged, marked.
            const partial = usageOf(stream.currentMessage?.usage);
            if (partial) {
                addUsage(partial);
            } else if (ending.errorCode !== 'PROVIDER_HTTP_ERROR' && ending.errorCode !== 'REQUEST_REFUSED') {
                costEstimated = true;
                spent += worstCaseCostMicroUsd(resolved.model, { inputTokens: inputTokenBound(request), outputTokens: 0 });
            }
            throw ending;
        }
    };

    const addUsage = (u: Usage): void => {
        usage = {
            inputTokens: usage.inputTokens + u.inputTokens,
            outputTokens: usage.outputTokens + u.outputTokens,
            cacheReadTokens: usage.cacheReadTokens + u.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens + u.cacheWriteTokens,
        };
        spent += costMicroUsd(resolved.model, {
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheReadTokens: u.cacheReadTokens,
            cacheWriteTokens: u.cacheWriteTokens,
        });
    };

    try {
        let request = firstRequest;
        let lastIssues: SafeIssue[] = [];
        for (let attempt = 1; attempt <= 2; attempt++) {
            await reserve(request);
            const message = await send(request);

            const stop = message.stop_reason;
            if (stop === 'refusal') {
                const category = message.stop_details?.category ?? null;
                throw new CallEnd('PROVIDER_ERROR', 'MODEL_REFUSED', (id) => new AiProviderError('MODEL_REFUSED', id, { category }));
            }
            // Cut off: by `max_tokens`, or by the context window. A repair
            // would only resend a longer request, so neither is repaired.
            if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') {
                throw new CallEnd('INVALID_OUTPUT', 'TRUNCATED', (id) => new AiOutputInvalidError('TRUNCATED', [], id));
            }
            // An answer ends `end_turn` (or `tool_use` on the single-tool
            // path). Anything else (`pause_turn`, `stop_sequence`, a stop this
            // layer does not know) did not end in an answer: not repaired.
            if (!(stop === 'end_turn' || (singleTool && stop === 'tool_use'))) {
                throw new CallEnd('INVALID_OUTPUT', 'NO_OUTPUT', (id) => new AiOutputInvalidError('NO_OUTPUT', [], id));
            }

            const { candidate, toolUseId } = candidateOf(message, singleTool);
            let failure: { safe: SafeIssue[]; repair: RepairIssue[] };
            if (candidate.ok) {
                const parsed = schema.safeParse(candidate.value);
                if (parsed.success) {
                    // 9. The answer, guard-scanned on the way out. A scanner
                    //    that throws fails closed: the answer is withheld.
                    let outbound: GuardCheck;
                    try {
                        outbound = guardModelOutput(parsed.data, resolved.guardMode);
                    } catch {
                        throw new CallEnd(
                            'REFUSED_GUARD',
                            'GUARD_UNAVAILABLE',
                            (id) => new AiGuardBlockedError('egress', [], id, true),
                        );
                    }
                    checks.push(outbound);
                    if (outbound.action === 'block') {
                        const ruleIds = [...outbound.ruleIds];
                        throw new CallEnd(
                            'REFUSED_GUARD',
                            'GUARD_BLOCKED_OUTPUT',
                            (id) => new AiGuardBlockedError('egress', ruleIds, id),
                        );
                    }
                    const outcome = attempt === 1 ? 'OK' : 'REPAIRED';
                    await settle(outcome, null);
                    const guard = summariseChecks(checks);
                    return {
                        callId,
                        value: parsed.data as z.infer<S>,
                        outcome,
                        attempts,
                        reviewRequired: guard.reviewRequired,
                        guardRuleIds: guard.ruleIds,
                        costMicroUsd: spent,
                    };
                }
                failure = issuesOf(parsed.error);
            } else {
                failure = { safe: candidate.safe, repair: candidate.repair };
            }
            lastIssues = failure.safe;
            // 8. One repair: the problems, as a new turn after the model's own.
            request = buildRepairRequest(firstRequest, asAssistantTurn(message), failure.repair, toolUseId);
        }
        const issues = lastIssues;
        // Twice no answer at all is NO_OUTPUT; anything else is a wrong answer.
        const reason = issues.length > 0 && issues.every((i) => NO_ANSWER_CODES.has(i.code)) ? 'NO_OUTPUT' : 'INVALID_AFTER_REPAIR';
        throw new CallEnd('INVALID_OUTPUT', reason, (id) => new AiOutputInvalidError(reason, issues, id));
    } catch (err) {
        if (err instanceof CallEnd) return end(err);
        // Not ours and not the SDK's (a ledger failure, a bug): record what is
        // known, then let the original error through.
        logger.error('ai: call failed unexpectedly', { component: 'ai', callId, errorName: err instanceof Error ? err.name : 'unknown' });
        await settle('PROVIDER_ERROR', 'INTERNAL_ERROR').catch(() => undefined);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}
