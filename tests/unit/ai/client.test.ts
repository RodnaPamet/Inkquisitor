/**
 * `clientForRun` — the one place an Anthropic client is built (roadmap rule 3).
 *
 * Ported in part from inflect-compliance's
 * `tests/unit/agentic/tool-runner-client.test.ts` refusal and middleware
 * cases (docs/carve-manifest.md): a client is refused without a key, with
 * ambient SDK headers, under the kill switch, and — in production — without the
 * operator's zero-retention statement; and every client's messages-only
 * middleware refuses, before `fetch` is called, anything but a Messages call
 * that asks Anthropic to hold nothing and run nothing. No test reaches a
 * network: `fetch` is a fake.
 */
import { classifySdkError, clientForRun, inspectRequest, jsonSchemaFor, PERMITTED_SERVER_TOOL_TYPES } from '@/lib/ai/client';
import { z } from 'zod';
import { FAKE_API_KEY_VALUE, fakeAnthropic, setFakeApiKey } from '../../helpers/fake-anthropic';

const URL_MESSAGES = 'https://api.anthropic.com/v1/messages';
const body = (b: Record<string, unknown>) => JSON.stringify({ model: 'm', max_tokens: 1, messages: [], ...b });

describe('inspectRequest (pure)', () => {
    it('admits a Messages POST with a custom tool and structured output', () => {
        const r = inspectRequest({
            method: 'POST',
            url: URL_MESSAGES,
            body: body({ tools: [{ name: 't', input_schema: {} }, { type: 'custom', name: 'u', input_schema: {} }], output_config: {} }),
        });
        expect(r.refusal).toBeNull();
        expect(r.shape).toEqual({ method: 'POST', path: '/v1/messages', bodyKeys: ['max_tokens', 'messages', 'model', 'output_config', 'tools'] });
    });

    it.each([
        ['another origin', { method: 'POST', url: 'https://evil.example/v1/messages', body: body({}) }, 'NOT_THE_PINNED_ORIGIN'],
        ['another path (batches)', { method: 'POST', url: 'https://api.anthropic.com/v1/messages/batches', body: body({}) }, 'NOT_A_MESSAGES_CALL'],
        ['the files API', { method: 'POST', url: 'https://api.anthropic.com/v1/files', body: body({}) }, 'NOT_A_MESSAGES_CALL'],
        ['a GET', { method: 'GET', url: URL_MESSAGES }, 'NOT_A_MESSAGES_CALL'],
        ['a beta header', { method: 'POST', url: URL_MESSAGES, body: body({}), headers: { 'Anthropic-Beta': 'message-threads-2026-08-12' } }, 'BETA_HEADER'],
        ['an unreadable body', { method: 'POST', url: URL_MESSAGES, body: '{not json' }, 'BODY_UNREADABLE'],
        ['a thread', { method: 'POST', url: URL_MESSAGES, body: body({ thread: { id: 't' } }) }, 'SERVER_HELD_STATE'],
        ['a container', { method: 'POST', url: URL_MESSAGES, body: body({ container: 'c' }) }, 'SERVER_HELD_STATE'],
        ['MCP servers', { method: 'POST', url: URL_MESSAGES, body: body({ mcp_servers: [] }) }, 'SERVER_HELD_STATE'],
        ['web search (a server tool)', { method: 'POST', url: URL_MESSAGES, body: body({ tools: [{ type: 'web_search_20260209', name: 'web_search' }] }) }, 'SERVER_TOOL'],
        ['code execution', { method: 'POST', url: URL_MESSAGES, body: body({ tools: [{ type: 'code_execution_20260521', name: 'code_execution' }] }) }, 'SERVER_TOOL'],
        ['a malformed tool', { method: 'POST', url: URL_MESSAGES, body: body({ tools: [null] }) }, 'SERVER_TOOL'],
    ] as const)('refuses %s', (_name, request, refusal) => {
        expect(inspectRequest(request).refusal).toBe(refusal);
    });

    it('a server tool passes only when the client was built to allow its type', () => {
        const request = { method: 'POST', url: URL_MESSAGES, body: body({ tools: [{ type: 'web_fetch_20260209', name: 'web_fetch' }] }) };
        expect(inspectRequest(request, ['web_fetch_20260209']).refusal).toBeNull();
        expect(inspectRequest(request, ['web_search_20260209']).refusal).toBe('SERVER_TOOL');
    });

    it('allows no server tool at all in 2.1 (subphase 2.6 adds web search and fetch, in one place)', () => {
        expect(PERMITTED_SERVER_TOOL_TYPES).toEqual([]);
    });

    it('the shape names the body members, never their values', () => {
        const r = inspectRequest({ method: 'POST', url: URL_MESSAGES, body: body({ system: 'SECRET PROMPT TEXT' }) });
        expect(JSON.stringify(r.shape)).not.toContain('SECRET PROMPT TEXT');
    });
});

describe('clientForRun', () => {
    const saved = { ...process.env };
    afterEach(() => {
        for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'AI_DISABLED', 'ANTHROPIC_ZDR_CONFIRMED', 'NODE_ENV']) {
            const e = process.env as Record<string, string | undefined>;
            if (saved[k] === undefined) delete e[k];
            else e[k] = saved[k];
        }
    });

    it('refuses without a key (the product runs with AI unavailable)', () => {
        delete process.env.ANTHROPIC_API_KEY;
        expect(clientForRun()).toEqual({ ok: false, reason: 'CREDENTIAL_NOT_CONFIGURED' });
    });

    it('refuses under the kill switch, before the key is read', () => {
        setFakeApiKey();
        process.env.AI_DISABLED = '1';
        expect(clientForRun()).toEqual({ ok: false, reason: 'AI_DISABLED' });
    });

    it('refuses while ANTHROPIC_CUSTOM_HEADERS is set', () => {
        setFakeApiKey();
        process.env.ANTHROPIC_CUSTOM_HEADERS = 'anthropic-beta: message-threads-2026-08-12';
        expect(clientForRun()).toEqual({ ok: false, reason: 'SDK_AMBIENT_HEADERS_SET' });
    });

    it('in production, refuses without the zero-retention statement (D5)', () => {
        setFakeApiKey();
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        expect(clientForRun()).toEqual({ ok: false, reason: 'ZDR_NOT_CONFIRMED' });
        process.env.ANTHROPIC_ZDR_CONFIRMED = '1';
        expect(clientForRun().ok).toBe(true);
    });

    it('builds a NEW client per call', () => {
        setFakeApiKey();
        const a = clientForRun();
        const b = clientForRun();
        expect(a.ok && b.ok && a.client !== b.client).toBe(true);
    });

    it('a Messages call goes out to the pinned host with the key and no beta header', async () => {
        setFakeApiKey();
        const api = fakeAnthropic([{ kind: 'text', text: '{}' }]);
        const choice = clientForRun({ fetch: api.fetch });
        if (!choice.ok) throw new Error(choice.reason);
        await choice.client.messages.stream({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }).finalMessage();
        expect(api.urls).toEqual([URL_MESSAGES]);
        expect(api.headers[0].get('anthropic-beta')).toBeNull();
        // SDK 1.x sends the key as a bearer credential.
        expect(api.headers[0].get('authorization')).toBe(`Bearer ${FAKE_API_KEY_VALUE}`);
    });

    it.each([
        ['a beta header', (c: import('@anthropic-ai/sdk').default) => c.messages.create({ model: 'm', max_tokens: 1, messages: [] }, { headers: { 'anthropic-beta': 'files-api-2025-04-14' } })],
        ['the models API', (c: import('@anthropic-ai/sdk').default) => c.models.list()],
        ['a batch', (c: import('@anthropic-ai/sdk').default) => c.messages.batches.list()],
        ['a server tool', (c: import('@anthropic-ai/sdk').default) => c.messages.create({ model: 'm', max_tokens: 1, messages: [], tools: [{ type: 'web_search_20250305', name: 'web_search' }] })],
    ])('refuses %s before fetch is ever called', async (_name, call) => {
        setFakeApiKey();
        const api = fakeAnthropic([{ kind: 'text', text: '{}' }]);
        const choice = clientForRun({ fetch: api.fetch });
        if (!choice.ok) throw new Error(choice.reason);
        const err = await call(choice.client).then(
            () => null,
            (e: unknown) => e,
        );
        expect(err).not.toBeNull();
        // callStructured reports it as REQUEST_REFUSED, never as a provider outage.
        expect(classifySdkError(err).kind).toBe('refused');
        expect(api.urls).toEqual([]);
    });
});

describe('jsonSchemaFor', () => {
    it('the API form: additionalProperties false, no $schema dialect, constraints moved out', () => {
        const schema = jsonSchemaFor(z.object({ q: z.string().min(5), n: z.number().int().max(3), tags: z.array(z.string()) }));
        expect(schema).not.toHaveProperty('$schema');
        expect(schema).not.toHaveProperty('description');
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required).toEqual(['q', 'n', 'tags']);
        expect(JSON.stringify(schema)).not.toContain('"minLength"');
        expect(JSON.stringify(schema)).not.toContain('"maximum"');
    });
});
