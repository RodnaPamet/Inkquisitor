/**
 * runServerToolLoop — a model turn that may run Anthropic's SERVER-SIDE web
 * search and web fetch tools, continued across `pause_turn` (Phase 2.6, the
 * research run's gather step; decision D9).
 *
 * New for Inkquisitor, beside `callStructured` (`./call-structured.ts`): that
 * function is ONE request for ONE validated object; a research gather is a
 * conversation the PROVIDER drives (it runs the tools in its own sampling loop
 * and returns `pause_turn` when that loop reaches its iteration limit), so it
 * needs a loop of requests. Every request still goes through the same seams:
 *
 *    • `clientForRun` (`./client.ts`, the one file that loads the SDK), built
 *      with exactly the server tool types the caller names, which must be in
 *      `PERMITTED_SERVER_TOOL_TYPES`; the messages-only middleware holds each
 *      tool definition to its shape (bounded `max_uses`, `allowed_callers:
 *      ["direct"]`) and lets the tools' result blocks back only in the
 *      assistant turn a continuation passes back;
 *    • the kill switch and the configuration, before anything is sent;
 *    • the guard over the author text of the FIRST request (later requests
 *      add no author text: they append the model's own turn);
 *    • the workspace's monthly ceiling: EVERY request reserves its own worst
 *      case before it leaves (`serverTurnWorstCase`), under the ledger's lock;
 *    • one `AiCallLog` row PER REQUEST, however it ended, with its billed
 *      search and fetch counts and the search fee in its cost.
 *
 * ── THE TOOL-USE CHECK, AND WHAT IT CANNOT DO ────────────────────────────────
 *
 * The caller hands `inspectToolUse`, run on every `server_tool_use` block as
 * soon as its input is complete in the stream (the SDK's `contentBlock`
 * event). A refusal aborts the request at once, the loop ends
 * `AiToolUseRefusedError` (REFUSED_GUARD, TOOL_USE_REFUSED) and nothing the
 * turn returned is used. BUT THE PROVIDER EXECUTES A SERVER TOOL ITSELF: the
 * search may already have been sent by the time its block reaches this
 * process, and the API offers no hook to approve a server tool call before it
 * runs (server tools documentation, read 2026-11-20). So this check is a
 * TRIPWIRE that stops the run and records it, not a gate. The research run's
 * real guarantee is upstream of it: the gather request carries no bible or
 * manuscript text for a query to quote (`src/lib/research/`).
 *
 * ── WHAT THE TURN RETURNS ────────────────────────────────────────────────────
 *
 * Every search the model ran (its query, and the hits' URLs, titles and page
 * ages — the hits' page text is encrypted by the provider and never readable
 * here), every page it fetched (the URL, the title, the plain text when the
 * page was text, the time it was retrieved, or the tool's error code), and the
 * turn's own closing text, which no caller treats as a finding. Nothing here is
 * logged but counts and codes.
 */
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import type { AiCallRecord, AiLedger } from './call-record';
import { spendPeriod } from './call-record';
import { classifySdkError, clientForRun, type PermittedServerToolType } from './client';
import { aiDisabled, monthlyCeilingMicroUsd, type AiEnvRecord } from './config';
import {
    AiCallAbortedError,
    AiCallError,
    AiGuardBlockedError,
    AiProviderError,
    AiSpendCeilingError,
    AiTimeoutError,
    AiToolUseRefusedError,
    AiUnavailableError,
    type AiCallOutcome,
    type AiErrorCode,
} from './errors';
import { guardAuthorText, summariseChecks, type GuardCheck } from './guard';
import { costMicroUsd, webSearchCostMicroUsd, worstCaseCostMicroUsd } from './pricing';
import { inputTokenBound, newFenceNonce, resolveCall, systemPromptFor, userTurnFor, type AuthorDataBlock, type PromptTemplate } from './prompt';
import { TIER_DEFAULTS } from './tiers';
import { RESERVATION_GRACE_MS } from './call-structured';

/** The server tool types a gather turn sends (both permitted in `./client.ts`). */
export const WEB_SEARCH_TOOL_TYPE: PermittedServerToolType = 'web_search_20260209';
export const WEB_FETCH_TOOL_TYPE: PermittedServerToolType = 'web_fetch_20260209';

/**
 * How many times the provider may sample within ONE request before it answers
 * `pause_turn` (its server-side loop's default limit: server tools
 * documentation, read 2026-11-20). Each sampling re-reads the conversation,
 * so a request's billed input is at most this many times its final context.
 */
export const SERVER_LOOP_ITERATIONS_BOUND = 10;

/**
 * An ASSUMED upper bound on the input tokens one search's results add. The
 * provider states no limit for direct searches (results are billed as input
 * tokens; their text is encrypted in the response), so this is a planning
 * figure for the worst-case reservation, not a provider guarantee: the
 * settled cost is the provider's own usage report whatever it is.
 */
export const SEARCH_RESULT_TOKENS_BOUND = 30_000;

export interface WebToolsSpec {
    /** The web search tool, or null for none. `maxUses` caps searches across the whole turn (the API enforces it). */
    readonly search: { readonly maxUses: number; readonly allowedDomains?: readonly string[]; readonly blockedDomains?: readonly string[] } | null;
    /** The web fetch tool, or null. `maxContentTokens` caps each fetched page's text. */
    readonly fetch: {
        readonly maxUses: number;
        readonly maxContentTokens: number;
        readonly allowedDomains?: readonly string[];
        readonly blockedDomains?: readonly string[];
    } | null;
}

/** A tool use as the stream completes it: which tool, and its input (a query, a URL). */
export interface ToolUseSeen {
    readonly tool: string;
    readonly input: unknown;
}

/** What the loop tells its observer: never text, counts only. */
export type ServerToolLoopEvent =
    | { readonly type: 'request'; readonly number: number }
    | { readonly type: 'tool_use'; readonly tool: 'web_search' | 'web_fetch'; readonly searches: number; readonly fetches: number };

export interface ServerToolLoopInput {
    readonly template: Readonly<PromptTemplate>;
    readonly data: readonly AuthorDataBlock[];
    readonly tools: WebToolsSpec;
    /** At most this many requests (the first plus `pause_turn` continuations). */
    readonly maxRequests: number;
    /** The loop sends no further request once the turn has cost this much (a soft cap: the worst case is the ceiling's). */
    readonly budgetMicroUsd: number;
    /** THE TRIPWIRE: a refusal code for a tool use that must not stand, or null. */
    readonly inspectToolUse: (use: ToolUseSeen) => string | null;
    readonly onEvent?: (event: ServerToolLoopEvent) => void;
    readonly bookId?: string | null;
    readonly requestedById?: string | null;
    readonly signal?: AbortSignal;
}

export interface ServerToolLoopDeps {
    readonly ledger: AiLedger;
    readonly env?: AiEnvRecord;
    /** TEST SEAM: the SDK's fetch. */
    readonly fetch?: typeof fetch;
    /** TEST SEAM: a shorter deadline per request than the tier's. */
    readonly timeoutMs?: number;
}

export interface SearchHit {
    readonly url: string;
    readonly title: string;
    readonly pageAge: string | null;
}

export interface SearchCall {
    readonly query: string;
    readonly hits: readonly SearchHit[];
    /** The tool's error code (`max_uses_exceeded`, `unavailable`, …), or null. */
    readonly errorCode: string | null;
}

export interface FetchedDocument {
    readonly url: string;
    readonly title: string | null;
    /** The page as plain text, or null when it was not text (a PDF) or the fetch failed. */
    readonly text: string | null;
    readonly retrievedAt: string | null;
    readonly errorCode: string | null;
}

export type ServerToolLoopStop = 'END_TURN' | 'REQUEST_CAP' | 'BUDGET' | 'TRUNCATED';

export interface ServerToolLoopResult {
    readonly stop: ServerToolLoopStop;
    readonly requests: number;
    readonly searches: readonly SearchCall[];
    readonly fetches: readonly FetchedDocument[];
    readonly finalText: string;
    readonly tokensUsed: number;
    readonly costMicroUsd: number;
    readonly callIds: readonly string[];
    readonly reviewRequired: boolean;
    readonly guardRuleIds: readonly string[];
    readonly webSearchRequests: number;
    readonly webFetchRequests: number;
}

/** The tool definitions a gather request sends, each in the shape the middleware admits. */
export function webToolDefinitions(tools: WebToolsSpec): Anthropic.ToolUnion[] {
    const defs: Anthropic.ToolUnion[] = [];
    if (tools.search) {
        defs.push({
            type: 'web_search_20260209',
            name: 'web_search',
            max_uses: tools.search.maxUses,
            allowed_callers: ['direct'],
            ...(tools.search.allowedDomains?.length ? { allowed_domains: [...tools.search.allowedDomains] } : {}),
            ...(tools.search.blockedDomains?.length ? { blocked_domains: [...tools.search.blockedDomains] } : {}),
        });
    }
    if (tools.fetch) {
        defs.push({
            type: 'web_fetch_20260209',
            name: 'web_fetch',
            max_uses: tools.fetch.maxUses,
            allowed_callers: ['direct'],
            max_content_tokens: tools.fetch.maxContentTokens,
            ...(tools.fetch.allowedDomains?.length ? { allowed_domains: [...tools.fetch.allowedDomains] } : {}),
            ...(tools.fetch.blockedDomains?.length ? { blocked_domains: [...tools.fetch.blockedDomains] } : {}),
        });
    }
    return defs;
}

/** The server tool types the spec asks a client to allow. */
export function serverToolTypesOf(tools: WebToolsSpec): PermittedServerToolType[] {
    return [...(tools.search ? [WEB_SEARCH_TOOL_TYPE] : []), ...(tools.fetch ? [WEB_FETCH_TOOL_TYPE] : [])];
}

/**
 * The most one gather request can cost before it is sent: every sampling
 * iteration the provider may run re-reading the request, every remaining
 * search's and fetch's content and the whole output budget (input priced at
 * the dearer of the input and cache-write rates), the output budget at the
 * output rate, and every remaining search's fee.
 */
export function serverTurnWorstCase(
    model: string,
    request: Anthropic.MessageStreamParams,
    remaining: { searches: number; fetches: number; maxContentTokens: number },
): number {
    const context =
        inputTokenBound(request) + remaining.searches * SEARCH_RESULT_TOKENS_BOUND + remaining.fetches * remaining.maxContentTokens + request.max_tokens;
    return (
        worstCaseCostMicroUsd(model, { inputTokens: context * SERVER_LOOP_ITERATIONS_BOUND, outputTokens: request.max_tokens }) +
        webSearchCostMicroUsd(remaining.searches)
    );
}

interface Usage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    searches: number;
    fetches: number;
}

function usageOf(u: Anthropic.Usage | undefined | null): Usage | null {
    if (!u) return null;
    return {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        searches: u.server_tool_use?.web_search_requests ?? 0,
        fetches: u.server_tool_use?.web_fetch_requests ?? 0,
    };
}

class LoopEnd extends Error {
    constructor(
        readonly outcome: AiCallOutcome,
        readonly errorCode: AiErrorCode,
        readonly toThrow: (callId: string) => Error,
    ) {
        super(errorCode);
    }
}

function endingOfSdkError(err: unknown, deadlineHit: boolean, callerAborted: boolean): LoopEnd {
    const kind = classifySdkError(err);
    if (deadlineHit) return new LoopEnd('TIMEOUT', 'DEADLINE', (id) => new AiTimeoutError(id));
    if (callerAborted) return new LoopEnd('ABORTED', 'CALLER_ABORT', (id) => new AiCallAbortedError(id));
    switch (kind.kind) {
        case 'refused':
            return new LoopEnd('PROVIDER_ERROR', 'REQUEST_REFUSED', (id) => new AiProviderError('REQUEST_REFUSED', id));
        case 'api':
            return new LoopEnd('PROVIDER_ERROR', 'PROVIDER_HTTP_ERROR', (id) => new AiProviderError('PROVIDER_HTTP_ERROR', id, { status: kind.status, type: kind.type }));
        default:
            return new LoopEnd('PROVIDER_ERROR', 'PROVIDER_CONNECTION', (id) => new AiProviderError('PROVIDER_CONNECTION', id));
    }
}

/** The response's blocks as the next request's assistant content: unchanged, but no empty text block. */
function passBack(content: readonly Anthropic.ContentBlock[]): Anthropic.ContentBlockParam[] {
    return (content as unknown as Anthropic.ContentBlockParam[]).filter((b) => !(b.type === 'text' && b.text === ''));
}

/** Read the searches and fetches out of a response's blocks. */
export function readToolResults(content: readonly Anthropic.ContentBlock[]): { searches: SearchCall[]; fetches: FetchedDocument[]; text: string } {
    const uses = new Map<string, { name: string; input: unknown }>();
    const searches: SearchCall[] = [];
    const fetches: FetchedDocument[] = [];
    const text: string[] = [];
    for (const block of content) {
        if (block.type === 'server_tool_use') uses.set(block.id, { name: block.name, input: block.input });
        else if (block.type === 'text') text.push(block.text);
        else if (block.type === 'web_search_tool_result') {
            const use = uses.get(block.tool_use_id);
            const query = typeof (use?.input as { query?: unknown } | undefined)?.query === 'string' ? String((use!.input as { query: string }).query) : '';
            if (Array.isArray(block.content)) {
                searches.push({
                    query,
                    hits: block.content
                        .filter((h) => h.type === 'web_search_result' && typeof h.url === 'string')
                        .map((h) => ({ url: h.url, title: typeof h.title === 'string' ? h.title : '', pageAge: h.page_age ?? null })),
                    errorCode: null,
                });
            } else {
                searches.push({ query, hits: [], errorCode: block.content?.error_code ?? 'unknown' });
            }
        } else if (block.type === 'web_fetch_tool_result') {
            const use = uses.get(block.tool_use_id);
            const askedUrl = typeof (use?.input as { url?: unknown } | undefined)?.url === 'string' ? String((use!.input as { url: string }).url) : '';
            const result = block.content;
            if (result.type === 'web_fetch_result') {
                const doc = result.content;
                const source = doc?.source as { type?: string; data?: unknown } | undefined;
                const pageText = source?.type === 'text' && typeof source.data === 'string' ? source.data : null;
                fetches.push({
                    url: result.url || askedUrl,
                    title: typeof doc?.title === 'string' ? doc.title : null,
                    text: pageText,
                    retrievedAt: result.retrieved_at ?? null,
                    errorCode: pageText === null ? 'NOT_TEXT' : null,
                });
            } else {
                fetches.push({ url: askedUrl, title: null, text: null, retrievedAt: null, errorCode: result.error_code ?? 'unknown' });
            }
        }
    }
    return { searches, fetches, text: text.join('') };
}

/**
 * THE server-tool loop. Returns what the turn found, or throws one of the
 * errors of `./errors.ts` (`AiToolUseRefusedError` among them) with the tokens
 * and cost of every request sent so far on it; every request settles its own
 * `AiCallLog` row first.
 */
export async function runServerToolLoop(input: ServerToolLoopInput, deps: ServerToolLoopDeps): Promise<ServerToolLoopResult> {
    const { template, data, tools } = input;
    const switches = deps.env ?? env;
    const resolved = resolveCall(template);
    const nonce = newFenceNonce(data);
    const ceiling = monthlyCeilingMicroUsd(switches);
    const timeoutMs = deps.timeoutMs ?? resolved.timeoutMs;
    const serverTools = serverToolTypesOf(tools);
    const maxContentTokens = tools.fetch?.maxContentTokens ?? 0;
    const effort = resolved.capabilities.effort ? TIER_DEFAULTS[template.tier].effort : null;

    const firstUser: Anthropic.MessageParam = { role: 'user', content: userTurnFor(template, data, 'json_schema', nonce) };
    const base: Anthropic.MessageStreamParams = {
        model: resolved.model,
        max_tokens: resolved.maxOutputTokens,
        system: [{ type: 'text', text: systemPromptFor(template), cache_control: { type: 'ephemeral' } }],
        messages: [firstUser],
        tools: webToolDefinitions(tools),
        ...(effort ? { output_config: { effort } } : {}),
    };

    const checks: GuardCheck[] = [];
    const callIds: string[] = [];
    const searches: SearchCall[] = [];
    const fetches: FetchedDocument[] = [];
    let assistant: Anthropic.ContentBlockParam[] = [];
    let finalText = '';
    let totalTokens = 0;
    let totalCost = 0;
    let searchRequests = 0;
    let fetchRequests = 0;
    let requests = 0;

    const settle = async (r: {
        callId: string;
        startedAt: Date;
        t0: number;
        usage: Usage;
        cost: number;
        costEstimated: boolean;
        worstCase: number;
        attempts: number;
        outcome: AiCallOutcome;
        errorCode: AiErrorCode | null;
    }): Promise<void> => {
        const guard = summariseChecks(checks);
        const record: AiCallRecord = {
            id: r.callId,
            bookId: input.bookId ?? null,
            requestedById: input.requestedById ?? null,
            purpose: template.purpose,
            promptId: template.id,
            promptVersion: template.version,
            tier: template.tier,
            model: resolved.model,
            outputMode: r.attempts > 0 ? 'server_tools' : null,
            attempts: r.attempts,
            inputTokens: r.usage.inputTokens,
            outputTokens: r.usage.outputTokens,
            cacheReadTokens: r.usage.cacheReadTokens,
            cacheWriteTokens: r.usage.cacheWriteTokens,
            costMicroUsd: r.cost,
            costEstimated: r.costEstimated,
            worstCaseMicroUsd: r.worstCase,
            durationMs: Date.now() - r.t0,
            outcome: r.outcome,
            errorCode: r.errorCode,
            guardRuleIds: guard.ruleIds,
            guardReviewRequired: guard.reviewRequired,
            webSearchRequests: r.usage.searches,
            webFetchRequests: r.usage.fetches,
            startedAt: r.startedAt,
        };
        await deps.ledger.settle(record);
        callIds.push(r.callId);
        totalTokens += r.usage.inputTokens + r.usage.outputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens;
        totalCost += r.cost;
        searchRequests += r.usage.searches;
        fetchRequests += r.usage.fetches;
        const costBudget = template.costBudgetMicroUsd ?? null;
        logger.info('ai: server-tool request settled', {
            component: 'ai',
            callId: r.callId,
            purpose: template.purpose,
            promptId: template.id,
            templateVersion: template.version,
            model: resolved.model,
            outcome: r.outcome,
            errorCode: r.errorCode,
            requestNumber: requests,
            searchCount: r.usage.searches,
            fetchCount: r.usage.fetches,
            costMicroUsd: r.cost,
            costBudgetMicroUsd: costBudget,
            overBudget: costBudget !== null && r.cost > costBudget,
            durationMs: record.durationMs,
        });
    };

    const fail = (e: LoopEnd, callId: string): never => {
        const error = e.toThrow(callId);
        if (error instanceof AiCallError) {
            error.tokensUsed = totalTokens;
            error.costMicroUsd = totalCost;
        }
        throw error;
    };

    const ZERO: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0, fetches: 0 };

    for (;;) {
        const callId = randomUUID();
        const startedAt = new Date();
        const t0 = Date.now();
        const nothingSent = async (e: LoopEnd): Promise<never> => {
            await settle({ callId, startedAt, t0, usage: ZERO, cost: 0, costEstimated: false, worstCase: 0, attempts: 0, outcome: e.outcome, errorCode: e.errorCode });
            return fail(e, callId);
        };

        if (input.signal?.aborted) return nothingSent(new LoopEnd('ABORTED', 'CALLER_ABORT', (id) => new AiCallAbortedError(id)));
        if (aiDisabled(switches)) return nothingSent(new LoopEnd('KILLED', 'AI_DISABLED', (id) => new AiUnavailableError('AI_DISABLED', id)));
        if (requests === 0) {
            try {
                checks.push(...guardAuthorText(data, resolved.guardMode));
            } catch {
                return nothingSent(new LoopEnd('REFUSED_GUARD', 'GUARD_UNAVAILABLE', (id) => new AiGuardBlockedError('input', [], id, true)));
            }
            const inbound = summariseChecks(checks);
            if (inbound.blocked) {
                const ruleIds = inbound.ruleIds;
                return nothingSent(new LoopEnd('REFUSED_GUARD', 'GUARD_BLOCKED_INPUT', (id) => new AiGuardBlockedError('input', ruleIds, id)));
            }
        }
        const choice = clientForRun({ callId, fetch: deps.fetch, timeoutMs, serverTools });
        if (!choice.ok) {
            const reason = choice.reason;
            return nothingSent(new LoopEnd(reason === 'AI_DISABLED' ? 'KILLED' : 'PROVIDER_ERROR', reason, (id) => new AiUnavailableError(reason, id)));
        }

        const request: Anthropic.MessageStreamParams =
            assistant.length > 0 ? { ...base, messages: [firstUser, { role: 'assistant', content: assistant }] } : base;
        const remaining = {
            searches: Math.max(0, (tools.search?.maxUses ?? 0) - searchRequests),
            fetches: Math.max(0, (tools.fetch?.maxUses ?? 0) - fetchRequests),
            maxContentTokens,
        };
        const worstCase = serverTurnWorstCase(resolved.model, request, remaining);
        const held = await deps.ledger.reserve({ callId, amountMicroUsd: worstCase, ceilingMicroUsd: ceiling, ttlMs: timeoutMs + RESERVATION_GRACE_MS, startedAt });
        if (!held.ok) {
            const details = {
                spentMicroUsd: held.spentMicroUsd,
                reservedMicroUsd: held.reservedMicroUsd,
                worstCaseMicroUsd: worstCase,
                ceilingMicroUsd: held.ceilingMicroUsd,
                period: spendPeriod(startedAt),
            };
            await settle({ callId, startedAt, t0, usage: ZERO, cost: 0, costEstimated: false, worstCase, attempts: 0, outcome: 'CEILING', errorCode: 'SPEND_CEILING' });
            return fail(new LoopEnd('CEILING', 'SPEND_CEILING', (id) => new AiSpendCeilingError(details, id)), callId);
        }

        requests += 1;
        input.onEvent?.({ type: 'request', number: requests });
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), timeoutMs);
        const tripwire = new AbortController();
        const signal = AbortSignal.any([deadline.signal, tripwire.signal, ...(input.signal ? [input.signal] : [])]);
        const trip: { refused: { tool: string; refusal: string } | null } = { refused: null };
        let seenSearches = 0;
        let seenFetches = 0;
        let message: Anthropic.Message;
        const stream = choice.client.messages.stream(request, { signal });
        stream.on('contentBlock', (block) => {
            if (block.type !== 'server_tool_use' || trip.refused) return;
            const tool = block.name;
            let refusal: string | null;
            try {
                refusal = tool === 'web_search' || tool === 'web_fetch' ? input.inspectToolUse({ tool, input: block.input }) : 'TOOL_NOT_PERMITTED';
            } catch {
                refusal = 'CHECK_UNAVAILABLE';
            }
            if (tool === 'web_search') seenSearches += 1;
            if (tool === 'web_fetch') seenFetches += 1;
            if (refusal) {
                trip.refused = { tool: String(tool), refusal };
                tripwire.abort();
                return;
            }
            input.onEvent?.({ type: 'tool_use', tool: tool as 'web_search' | 'web_fetch', searches: searchRequests + seenSearches, fetches: fetchRequests + seenFetches });
        });
        try {
            message = await stream.finalMessage();
        } catch (err) {
            clearTimeout(timer);
            // What the stream reported, if anything; a refused tool use's searches are charged as seen (the provider ran them).
            const partial = usageOf(stream.currentMessage?.usage);
            const usage: Usage = partial
                ? { ...partial, searches: Math.max(partial.searches, seenSearches), fetches: Math.max(partial.fetches, seenFetches) }
                : { ...ZERO, searches: seenSearches, fetches: seenFetches };
            let cost = costMicroUsd(resolved.model, usage) + webSearchCostMicroUsd(usage.searches);
            let costEstimated = false;
            const r = trip.refused;
            const ending: LoopEnd = r
                ? new LoopEnd('REFUSED_GUARD', 'TOOL_USE_REFUSED', (id) => new AiToolUseRefusedError(r.tool, r.refusal, id))
                : endingOfSdkError(err, deadline.signal.aborted, input.signal?.aborted === true);
            if (!partial && ending.errorCode !== 'PROVIDER_HTTP_ERROR' && ending.errorCode !== 'REQUEST_REFUSED') {
                costEstimated = true;
                cost += worstCaseCostMicroUsd(resolved.model, { inputTokens: inputTokenBound(request), outputTokens: 0 });
            }
            await settle({ callId, startedAt, t0, usage, cost, costEstimated, worstCase, attempts: 1, outcome: ending.outcome, errorCode: ending.errorCode });
            return fail(ending, callId);
        }
        clearTimeout(timer);
        const usage = usageOf(message.usage) ?? ZERO;
        const cost = costMicroUsd(resolved.model, usage) + webSearchCostMicroUsd(usage.searches);
        if (message.stop_reason === 'refusal') {
            await settle({ callId, startedAt, t0, usage, cost, costEstimated: false, worstCase, attempts: 1, outcome: 'PROVIDER_ERROR', errorCode: 'MODEL_REFUSED' });
            const category = message.stop_details?.category ?? null;
            return fail(new LoopEnd('PROVIDER_ERROR', 'MODEL_REFUSED', (id) => new AiProviderError('MODEL_REFUSED', id, { category })), callId);
        }
        await settle({ callId, startedAt, t0, usage, cost, costEstimated: false, worstCase, attempts: 1, outcome: 'OK', errorCode: null });

        const read = readToolResults(message.content);
        searches.push(...read.searches);
        fetches.push(...read.fetches);
        finalText = read.text;
        assistant = [...assistant, ...passBack(message.content)];

        const result = (stop: ServerToolLoopStop): ServerToolLoopResult => {
            const guard = summariseChecks(checks);
            return {
                stop,
                requests,
                searches,
                fetches,
                finalText,
                tokensUsed: totalTokens,
                costMicroUsd: totalCost,
                callIds,
                reviewRequired: guard.reviewRequired,
                guardRuleIds: guard.ruleIds,
                webSearchRequests: searchRequests,
                webFetchRequests: fetchRequests,
            };
        };
        if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') return result('TRUNCATED');
        if (message.stop_reason !== 'pause_turn') return result('END_TURN');
        if (requests >= input.maxRequests) return result('REQUEST_CAP');
        if (totalCost >= input.budgetMicroUsd) return result('BUDGET');
    }
}
