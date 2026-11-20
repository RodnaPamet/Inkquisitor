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
import {
    classifySdkError,
    clientForRun,
    inspectRequest,
    jsonSchemaFor,
    MAX_OPTIONAL_PARAMETERS,
    MAX_UNION_PARAMETERS,
    PERMITTED_SERVER_TOOL_TYPES,
} from '@/lib/ai/client';
import { AiPromptError } from '@/lib/ai/errors';
import { anthropicWorkspaceHeaders } from '@/lib/ai/anthropic-workspace';
import { aiConfigProblems } from '@/lib/ai/config';
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
        // Deny by default: what the allowlists do not name is refused unnamed.
        ['the beta endpoint (?beta=true)', { method: 'POST', url: `${URL_MESSAGES}?beta=true`, body: body({}) }, 'NOT_A_MESSAGES_CALL'],
        ['context management (an unlisted member)', { method: 'POST', url: URL_MESSAGES, body: body({ context_management: { edits: [] } }) }, 'SERVER_HELD_STATE'],
        ['metadata (an identifier sent to the provider)', { method: 'POST', url: URL_MESSAGES, body: body({ metadata: { user_id: 'u' } }) }, 'SERVER_HELD_STATE'],
        ['a thread set to null', { method: 'POST', url: URL_MESSAGES, body: body({ thread: null }) }, 'SERVER_HELD_STATE'],
        ['an output_config member besides format and effort', { method: 'POST', url: URL_MESSAGES, body: body({ output_config: { task_budget: { type: 'tokens', total: 1 } } }) }, 'SERVER_HELD_STATE'],
        [
            'a document Anthropic would fetch from a URL',
            { method: 'POST', url: URL_MESSAGES, body: body({ messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://x.example/a.pdf' } }] }] }) },
            'CONTENT_BLOCK',
        ],
        [
            'an image read from the Files API',
            { method: 'POST', url: URL_MESSAGES, body: body({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'file_1' } }] }] }) },
            'CONTENT_BLOCK',
        ],
        [
            'a container upload',
            { method: 'POST', url: URL_MESSAGES, body: body({ messages: [{ role: 'user', content: [{ type: 'container_upload', file_id: 'file_1' }] }] }) },
            'CONTENT_BLOCK',
        ],
        [
            'a document inside a tool result',
            {
                method: 'POST',
                url: URL_MESSAGES,
                body: body({
                    messages: [
                        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'document', source: { type: 'url', url: 'https://x.example' } }] }] },
                    ],
                }),
            },
            'CONTENT_BLOCK',
        ],
        [
            'a server-tool block in the history',
            { method: 'POST', url: URL_MESSAGES, body: body({ messages: [{ role: 'assistant', content: [{ type: 'server_tool_use', id: 's', name: 'web_search', input: {} }] }] }) },
            'CONTENT_BLOCK',
        ],
        ['a system prompt carrying a document', { method: 'POST', url: URL_MESSAGES, body: body({ system: [{ type: 'document', source: { type: 'url', url: 'https://x.example' } }] }) }, 'CONTENT_BLOCK'],
    ] as const)('refuses %s', (_name, request, refusal) => {
        expect(inspectRequest(request).refusal).toBe(refusal);
    });

    const fetchTool = { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 4, allowed_callers: ['direct'], max_content_tokens: 8000 };
    const searchTool = { type: 'web_search_20260209', name: 'web_search', max_uses: 3, allowed_callers: ['direct'] };

    it('a server tool passes only when the client was built to allow its type', () => {
        const request = { method: 'POST', url: URL_MESSAGES, body: body({ tools: [fetchTool] }) };
        expect(inspectRequest(request, ['web_fetch_20260209']).refusal).toBeNull();
        expect(inspectRequest(request, ['web_search_20260209']).refusal).toBe('SERVER_TOOL');
    });

    it('allows EXACTLY the web search and web fetch types (2.6, decision D9), in one place', () => {
        expect([...PERMITTED_SERVER_TOOL_TYPES]).toEqual(['web_search_20260209', 'web_fetch_20260209']);
        // Every other server tool type stays refused even when a caller names it.
        for (const type of ['code_execution_20260521', 'web_search_20260318', 'web_fetch_20260309', 'web_search_20250305', 'bash_20250124', 'mcp_toolset']) {
            const request = { method: 'POST', url: URL_MESSAGES, body: body({ tools: [{ ...searchTool, type }] }) };
            expect(inspectRequest(request, [...PERMITTED_SERVER_TOOL_TYPES, type]).refusal).toBe('SERVER_TOOL');
        }
    });

    it.each([
        ['dynamic filtering (the code execution caller)', { ...searchTool, allowed_callers: ['code_execution_20260120'] }],
        ['no allowed_callers (the 20260209 default is code execution)', { type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
        ['both callers', { ...searchTool, allowed_callers: ['direct', 'code_execution_20260120'] }],
        ['no max_uses (an uncapped tool)', { type: 'web_search_20260209', name: 'web_search', allowed_callers: ['direct'] }],
        ['a max_uses past the ceiling', { ...searchTool, max_uses: 51 }],
        ['a fractional max_uses', { ...searchTool, max_uses: 2.5 }],
        ['another name', { ...searchTool, name: 'search' }],
        ['a member outside the shape (user_location)', { ...searchTool, user_location: { type: 'approximate', country: 'GB' } }],
        ['a member outside the shape (cache_control)', { ...searchTool, cache_control: { type: 'ephemeral' } }],
    ])('refuses a web search definition with %s', (_name, tool) => {
        const request = { method: 'POST', url: URL_MESSAGES, body: body({ tools: [tool] }) };
        expect(inspectRequest(request, [...PERMITTED_SERVER_TOOL_TYPES]).refusal).toBe('SERVER_TOOL');
    });

    it('lets a pause_turn continuation pass the server tools\' own blocks back in the ASSISTANT turn only', () => {
        const turn = [
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } },
            { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
            { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_fetch', input: { url: 'https://example.org/' } },
            { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'web_fetch_tool_result_error', error_code: 'unavailable' } },
            { type: 'text', text: 'reading' },
        ];
        const assistant = { method: 'POST', url: URL_MESSAGES, body: body({ tools: [searchTool, fetchTool], messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: turn }] }) };
        expect(inspectRequest(assistant, [...PERMITTED_SERVER_TOOL_TYPES]).refusal).toBeNull();
        // Not for a client that allows no server tool, nor in a user turn, nor for a tool the client does not allow.
        expect(inspectRequest(assistant).refusal).toBe('CONTENT_BLOCK');
        const user = { method: 'POST', url: URL_MESSAGES, body: body({ tools: [searchTool], messages: [{ role: 'user', content: turn.slice(0, 2) }] }) };
        expect(inspectRequest(user, [...PERMITTED_SERVER_TOOL_TYPES]).refusal).toBe('CONTENT_BLOCK');
        const searchOnly = { method: 'POST', url: URL_MESSAGES, body: body({ tools: [searchTool], messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: turn }] }) };
        expect(inspectRequest(searchOnly, ['web_search_20260209']).refusal).toBe('CONTENT_BLOCK');
        const otherUse = { method: 'POST', url: URL_MESSAGES, body: body({ tools: [searchTool], messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'server_tool_use', id: 's', name: 'code_execution', input: {} }] }] }) };
        expect(inspectRequest(otherUse, [...PERMITTED_SERVER_TOOL_TYPES]).refusal).toBe('CONTENT_BLOCK');
    });

    it('the shape names the body members, never their values', () => {
        const r = inspectRequest({ method: 'POST', url: URL_MESSAGES, body: body({ system: 'SECRET PROMPT TEXT' }) });
        expect(JSON.stringify(r.shape)).not.toContain('SECRET PROMPT TEXT');
    });
});

describe('clientForRun', () => {
    const saved = { ...process.env };
    afterEach(() => {
        for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'AI_DISABLED', 'ANTHROPIC_ZDR_CONFIRMED', 'AI_RETENTION_MODE', 'NODE_ENV', 'ANTHROPIC_WORKSPACE_ID']) {
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

    it('in production, refuses without a declared retention mode (D5, amended 2026-11-19)', () => {
        setFakeApiKey();
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        expect(clientForRun()).toEqual({ ok: false, reason: 'RETENTION_MODE_UNDECLARED' });
        process.env.ANTHROPIC_ZDR_CONFIRMED = '1';
        expect(clientForRun().ok).toBe(true);
        delete process.env.ANTHROPIC_ZDR_CONFIRMED;
        process.env.AI_RETENTION_MODE = 'standard-beta';
        expect(clientForRun().ok).toBe(true);
        process.env.AI_RETENTION_MODE = 'zdr';
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

    it('names the workspace an organisation-level key belongs to, only when one is configured (2.3)', async () => {
        setFakeApiKey();
        const api = fakeAnthropic([{ kind: 'text', text: '{}' }, { kind: 'text', text: '{}' }]);
        const send = async () => {
            const choice = clientForRun({ fetch: api.fetch });
            if (!choice.ok) throw new Error(choice.reason);
            await choice.client.messages.stream({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }).finalMessage();
        };
        delete process.env.ANTHROPIC_WORKSPACE_ID;
        await send();
        process.env.ANTHROPIC_WORKSPACE_ID = '  wrkspc_evals01\n';
        await send();
        expect(api.headers[0].get('anthropic-workspace-id')).toBeNull();
        expect(api.headers[1].get('anthropic-workspace-id')).toBe('wrkspc_evals01');
        expect(anthropicWorkspaceHeaders('   ')).toEqual({});
    });

    it('never sends a malformed workspace id: no header at all, and production refuses to start with one (2.3)', async () => {
        for (const bad of ['wrkspc_a\r\nx-injected: 1', 'wrkspc_a, wrkspc_b', 'wrkspc a', 'wrkspc_"a"', 'x'.repeat(129)]) {
            expect([bad, anthropicWorkspaceHeaders(bad)]).toEqual([bad, {}]);
            expect(aiConfigProblems({ ANTHROPIC_WORKSPACE_ID: bad }).some((p) => p.includes('ANTHROPIC_WORKSPACE_ID'))).toBe(true);
        }
        expect(anthropicWorkspaceHeaders('wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ')).toEqual({ 'anthropic-workspace-id': 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ' });
        const workspaceProblems = (e: Record<string, string>) => aiConfigProblems(e).filter((p) => p.includes('ANTHROPIC_WORKSPACE_ID'));
        expect(workspaceProblems({ ANTHROPIC_WORKSPACE_ID: ' wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ\n' })).toEqual([]);
        expect(workspaceProblems({})).toEqual([]);
        setFakeApiKey();
        const api = fakeAnthropic([{ kind: 'text', text: '{}' }]);
        process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_a\nx-injected: 1';
        const choice = clientForRun({ fetch: api.fetch });
        if (!choice.ok) throw new Error(choice.reason);
        await choice.client.messages.stream({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }).finalMessage();
        expect(api.headers[0].get('anthropic-workspace-id')).toBeNull();
        expect(api.headers[0].get('x-injected')).toBeNull();
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

    // What the structured-output feature refuses is refused HERE, at build,
    // rather than as a 400 on every call or a schema the transform empties.
    type Tree = { name: string; kids: Tree[] };
    const Tree: z.ZodType<Tree> = z.object({
        name: z.string(),
        get kids() {
            return z.array(Tree);
        },
    });
    const many = (n: number, make: () => z.ZodType) => z.object(Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, make()])));

    it.each([
        ['a recursive schema (the API refuses recursion)', z.object({ root: Tree }), /recursive/],
        ['a record (the transform would make it an empty object)', z.object({ counts: z.record(z.string(), z.number()) }), /arbitrary keys/],
        ['a record keyed by an enum', z.object({ counts: z.record(z.enum(['a', 'b']), z.number()) }), /arbitrary keys/],
        ['an array at the root (the single-tool path needs an object)', z.array(z.string()), /object at its root/],
        ['more optional parameters than the API compiles', many(MAX_OPTIONAL_PARAMETERS + 1, () => z.string().optional()), /optional parameters/],
        ['more union parameters than the API compiles', many(MAX_UNION_PARAMETERS + 1, () => z.string().nullable()), /union parameters/],
    ] as const)('refuses %s', (_name, schema, problem) => {
        const err = (() => {
            try {
                jsonSchemaFor(schema);
                return null;
            } catch (e) {
                return e;
            }
        })();
        expect(err).toBeInstanceOf(AiPromptError);
        expect(JSON.stringify((err as AiPromptError).details)).toMatch(problem);
    });

    it('accepts what the feature takes: optional, nullable, unions, a reused (non-recursive) definition', () => {
        const Person = z.object({ name: z.string() });
        const schema = jsonSchemaFor(
            z.object({
                a: z.string().optional(),
                b: z.string().nullable(),
                c: z.union([z.object({ k: z.literal('x') }), z.object({ k: z.literal('y'), v: z.string() })]),
                lead: Person,
                others: z.array(Person),
                limit: many(MAX_OPTIONAL_PARAMETERS - 1, () => z.number().optional()),
            }),
        );
        expect(schema.type).toBe('object');
        expect(schema.required).toEqual(['b', 'c', 'lead', 'others', 'limit']);
    });
});
