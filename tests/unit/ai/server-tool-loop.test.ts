/**
 * runServerToolLoop (Phase 2.6): a server-tool turn through the real SDK, the
 * real messages-only middleware and the fake Messages API, against an
 * in-memory ledger. No network.
 */
import { definePrompt } from '@/lib/ai/prompt';
import { runServerToolLoop, serverTurnWorstCase, webToolDefinitions, type ServerToolLoopInput } from '@/lib/ai/server-tool-loop';
import { WEB_SEARCH_MICRO_USD_PER_REQUEST } from '@/lib/ai/pricing';
import { AiSpendCeilingError, AiToolUseRefusedError, AiUnavailableError } from '@/lib/ai/errors';
import { fakeAnthropic, setFakeApiKey, type FakeTurn } from '../../helpers/fake-anthropic';
import { gatherEvents } from '../../helpers/fake-web';
import { memoryLedger } from '../../helpers/memory-ai-ledger';

const TEMPLATE = definePrompt({ id: 'test.gather', version: 't.1', purpose: 'test.gather', tier: 'balanced', system: 'Find sources.', task: 'Research the question.', maxOutputTokens: 2_000 });
const PAGE = { url: 'https://falconry.example.org/manning', title: 'Manning', text: 'Medieval falconers began training by manning the bird.' };
const TOOLS = { search: { maxUses: 3 }, fetch: { maxUses: 4, maxContentTokens: 8_000 } };

let restore: () => void;
beforeEach(() => {
    restore = setFakeApiKey();
});
afterEach(() => restore());

function run(turns: FakeTurn[], over: Partial<ServerToolLoopInput> = {}, ledger = memoryLedger(), env: Record<string, string | undefined> = {}) {
    const api = fakeAnthropic(turns);
    const promise = runServerToolLoop(
        { template: TEMPLATE, data: [{ label: 'brief.question', text: 'How did falconers train hawks?' }], tools: TOOLS, maxRequests: 3, budgetMicroUsd: 1_000_000, inspectToolUse: () => null, ...over },
        { ledger, fetch: api.fetch, env },
    );
    return { api, ledger, promise };
}

it('sends exactly the two web tools, direct callers, bounded uses; reads the searches and pages; one record with the search fee', async () => {
    const seen: string[] = [];
    const { api, ledger, promise } = run([{ kind: 'events', events: gatherEvents({ query: 'falconry training', pages: [PAGE] }) }], { inspectToolUse: (u) => (seen.push(u.tool), null) });
    const r = await promise;
    expect(api.requests[0].tools).toEqual(webToolDefinitions(TOOLS));
    expect(r).toMatchObject({ stop: 'END_TURN', requests: 1, webSearchRequests: 1, webFetchRequests: 1 });
    expect(r.searches).toEqual([{ query: 'falconry training', hits: [{ url: PAGE.url, title: PAGE.title, pageAge: null }], errorCode: null }]);
    expect(r.fetches).toEqual([{ url: PAGE.url, title: PAGE.title, text: PAGE.text, retrievedAt: '2026-11-20T10:00:00Z', errorCode: null }]);
    expect(seen).toEqual(['web_search', 'web_fetch']);
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({ outputMode: 'server_tools', outcome: 'OK', webSearchRequests: 1, webFetchRequests: 1 });
    expect(ledger.records[0].costMicroUsd).toBeGreaterThanOrEqual(WEB_SEARCH_MICRO_USD_PER_REQUEST);
});

it('the tripwire cuts the turn on a refused tool use: REFUSED_GUARD TOOL_USE_REFUSED, nothing returned, the search charged', async () => {
    const { ledger, promise } = run([{ kind: 'events', events: gatherEvents({ query: 'the secret of the book', pages: [PAGE] }) }], { inspectToolUse: (u) => (u.tool === 'web_search' ? 'QUOTES_BOOK_TEXT' : null) });
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiToolUseRefusedError);
    expect((err as AiToolUseRefusedError).details).toMatchObject({ tool: 'web_search', refusal: 'QUOTES_BOOK_TEXT' });
    expect(ledger.records[0]).toMatchObject({ outcome: 'REFUSED_GUARD', errorCode: 'TOOL_USE_REFUSED', webSearchRequests: 1 });
    expect(ledger.records[0].costMicroUsd).toBeGreaterThanOrEqual(WEB_SEARCH_MICRO_USD_PER_REQUEST);
});

it('a turn cut off mid-stream is charged its unseen output at the bound, marked estimated, within its reservation (issue #30, item 10)', async () => {
    const { api, ledger, promise } = run([{ kind: 'events', events: gatherEvents({ query: 'the secret of the book', pages: [PAGE] }) }], { inspectToolUse: (u) => (u.tool === 'web_search' ? 'QUOTES_BOOK_TEXT' : null) });
    await promise.catch(() => undefined);
    const record = ledger.records[0];
    expect(record.costEstimated).toBe(true);
    const maxTokens = (api.requests[0] as { max_tokens: number }).max_tokens;
    // 1,500 input tokens reported at message_start, the search fee, and the output up to max_tokens.
    expect(record.costMicroUsd).toBe(1_500 * 2 + maxTokens * 10 + WEB_SEARCH_MICRO_USD_PER_REQUEST);
    expect(record.costMicroUsd).toBeLessThanOrEqual(record.worstCaseMicroUsd);
});

it('continues a pause_turn with the model’s own turn passed back; stops at the request cap', async () => {
    const pause = (id: string): FakeTurn => ({ kind: 'events', events: gatherEvents({ query: `q ${id}`, pages: [PAGE], fetchUrls: [], stop: 'pause_turn', idBase: id }) });
    const { api, ledger, promise } = run([pause('a'), pause('b'), pause('c')], { maxRequests: 2 });
    const r = await promise;
    expect(r).toMatchObject({ stop: 'REQUEST_CAP', requests: 2 });
    expect(ledger.records).toHaveLength(2);
    const second = api.requests[1] as { messages: Array<{ role: string }> };
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
});

it('sends no further request once the turn has spent its budget', async () => {
    const pause: FakeTurn = { kind: 'events', events: gatherEvents({ query: 'q', pages: [PAGE], fetchUrls: [], stop: 'pause_turn' }) };
    const { ledger, promise } = run([pause, pause], { budgetMicroUsd: 1 });
    expect((await promise).stop).toBe('BUDGET');
    expect(ledger.records).toHaveLength(1);
});

it('reserves each request’s worst case — every sampling iteration, every remaining search and page, the search fees — before it is sent', async () => {
    const ledger = memoryLedger({ alreadySpent: 50_000_000 - 1_000 });
    const { api, promise } = run([{ kind: 'events', events: gatherEvents({ query: 'q', pages: [PAGE] }) }], {}, ledger);
    await expect(promise).rejects.toBeInstanceOf(AiSpendCeilingError);
    expect(api.requests).toHaveLength(0);
    expect(ledger.records[0]).toMatchObject({ outcome: 'CEILING', attempts: 0 });
    const worst = serverTurnWorstCase('claude-sonnet-5-5', { model: 'claude-sonnet-5-5', max_tokens: 2_000, messages: [] }, { searches: 3, fetches: 4, maxContentTokens: 8_000 });
    expect(worst).toBeGreaterThan(3 * WEB_SEARCH_MICRO_USD_PER_REQUEST);
});

it('the kill switch refuses before anything is sent', async () => {
    const { api, promise } = run([], {}, memoryLedger(), { AI_DISABLED: '1' });
    await expect(promise).rejects.toBeInstanceOf(AiUnavailableError);
    expect(api.requests).toHaveLength(0);
});
