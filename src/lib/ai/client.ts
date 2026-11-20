/**
 * THE ONE PLACE AN ANTHROPIC CLIENT IS BUILT (roadmap rule 3, Phase 2.1).
 *
 * Lifted from inflect-compliance's `src/lib/agentic/tool-runner/client.ts`
 * (see docs/carve-manifest.md). Inflect chose the client from a tenant's
 * residency terms; Inkquisitor has one route to one provider, so that branch
 * is gone. The workspace header came back in 2.3 (`ANTHROPIC_WORKSPACE_ID`,
 * `./anthropic-workspace.ts`): an organisation-level key, such as the one the
 * `Evals` workflow runs on, is refused HTTP 400 without it. What stays is what keeps a call
 * honest: a NEW client per call (nothing cached, so no two calls share an
 * instance), the environment pinned out, and a middleware that lets nothing
 * but a Messages call leave.
 *
 * `eslint.config.mjs` refuses a value import of any `@anthropic-ai/*` package
 * anywhere under `src/` except this file (`local/anthropic-client-single-seam`).
 * With the class importable in one file only, a second construction site
 * cannot exist. Type imports stay allowed. What else this layer needs from the
 * SDK at run time — the JSON schema of an output format and the
 * classification of an SDK error — is exported from here for that reason.
 *
 * ── WHEN THERE IS NO CLIENT ─────────────────────────────────────────────────
 *
 *   AI_DISABLED=1               refused first, before anything is read: the
 *                               kill switch (`callStructured` asks it earlier
 *                               still; this is the backstop)
 *   no ANTHROPIC_API_KEY        CREDENTIAL_NOT_CONFIGURED: the product runs
 *                               with AI unavailable
 *   ANTHROPIC_CUSTOM_HEADERS    SDK_AMBIENT_HEADERS_SET (below)
 *   production, no AI_RETENTION_MODE (nor ANTHROPIC_ZDR_CONFIRMED=1)
 *                               RETENTION_MODE_UNDECLARED: decision D5 (amended
 *                               2026-11-19). The start-up check refuses the
 *                               process first (`./config.ts`)
 *
 * ── WHAT THE SDK WOULD OTHERWISE TAKE FROM THE ENVIRONMENT ─────────────────
 *
 *   ANTHROPIC_BASE_URL       → `baseURL` is pinned to Anthropic's API, so the
 *                              host a call reaches is decided in code
 *   ANTHROPIC_LOG            → `logLevel` is pinned to 'warn'; at 'debug' the
 *                              SDK logs requests, which carry author text.
 *                              Its logger is ours and drops the arguments
 *   ANTHROPIC_OPEN_TELEMETRY_* → tracing is pinned to `metadata_only`, so no
 *                              span carries message content, and no trace
 *                              context is sent to Anthropic
 *   ANTHROPIC_WEBHOOK_SIGNING_KEY → `webhookKey` is null
 *   ANTHROPIC_AUTH_TOKEN, profiles and the credential chain → never read:
 *                              passing `apiKey` is the client's only
 *                              credential, and the SDK then reads no other
 *
 * One cannot be pinned: `ANTHROPIC_CUSTOM_HEADERS` is merged into every request
 * and no option turns that off. A header set there — a beta flag that stores
 * conversations, say — would apply to every call without a line of code saying
 * so, so while it is set `clientForRun` refuses.
 *
 * ── WHAT A CLIENT MAY SEND: DENY BY DEFAULT ─────────────────────────────────
 *
 * The SDK reaches every Anthropic API: files, skills, batches, server-held
 * threads, Managed Agents. Several of those STORE data, and a ZDR arrangement
 * does not block them, it just stops covering the data. Every client built
 * here carries `messagesOnlyFor`'s middleware, which runs before each request
 * leaves the process (retries included) and refuses anything that is not:
 *
 *   • a POST to `/v1/messages` on the pinned origin, with no query string
 *     (`?beta=true` is the beta endpoint) and no `anthropic-beta` header; and
 *   • a body that asks Anthropic to hold nothing and call nothing on the
 *     call's behalf. That is an ALLOWLIST, not a list of known dangers:
 *       - top-level members from `PERMITTED_BODY_MEMBERS` only (so no `thread`,
 *         `container`, `mcp_servers`, `context_management`, `metadata` or any
 *         member a later API version adds), and `output_config` members from
 *         `PERMITTED_OUTPUT_CONFIG_MEMBERS` only;
 *       - system and message content blocks of the types in
 *         `PERMITTED_CONTENT_BLOCK_TYPES` only, a `tool_result`'s content
 *         included: no `document` or `image` (a `url` source is a fetch
 *         Anthropic makes, a `file` source reads the Files API's storage), no
 *         `container_upload`, `search_result` or server-tool blocks;
 *       - no tool whose `type` is not `custom` — unless that server tool's
 *         type is one the CLIENT was built to allow, and every type a client
 *         may be built to allow is in `PERMITTED_SERVER_TOOL_TYPES`.
 *
 * `PERMITTED_SERVER_TOOL_TYPES` is EMPTY in 2.1, typed so that no caller can
 * name a server tool at all. Subphase 2.6 (decision D9) adds exactly the web
 * search and web fetch tool types to that one list, in a reviewed diff, and
 * the research run asks for them by name; every other client still allows
 * none. (Read the current Anthropic documentation then: dynamic filtering on
 * the `_20260209` variants is not zero-retention eligible.)
 *
 * ── THE TEST SEAM ───────────────────────────────────────────────────────────
 *
 * `fetch` replaces the network for tests (the SDK takes a custom fetch, and the
 * middleware still runs in front of it). No production caller passes it. The
 * stubbed model (`AI_MODEL_STUB=1`, Phase 2.4, `./model-stub.ts`) is the same
 * seam taken by configuration, for a local test server: refused in a real
 * production configuration at start-up, and never beside a key.
 */
import Anthropic, { APIConnectionError, APIError, APIUserAbortError, type Middleware } from '@anthropic-ai/sdk';
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import { z } from 'zod';

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { anthropicWorkspaceHeaders } from './anthropic-workspace';
import { aiUnavailableReason, stubModelActive } from './config';
import { stubMessagesFetch } from './model-stub';
import { AiPromptError, AiRequestRefusedError, type AiUnavailableReason } from './errors';

/** The Messages API's origin. Pinned, so the environment cannot move the traffic. */
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';

/** The one API path a client may call. */
export const MESSAGES_PATH = '/v1/messages';

/** Retries the SDK makes on 408/409/429/5xx and connection errors (its own default, pinned). */
export const CLIENT_MAX_RETRIES = 2;

/**
 * THE server tools a client may ever be built to allow. Empty: no model call
 * in 2.1 runs a tool at Anthropic. Subphase 2.6 adds the web search and web
 * fetch types HERE and nowhere else (see the header).
 */
export const PERMITTED_SERVER_TOOL_TYPES = [] as const;
export type PermittedServerToolType = (typeof PERMITTED_SERVER_TOOL_TYPES)[number];

export type ClientChoice = { ok: true; client: Anthropic } | { ok: false; reason: AiUnavailableReason };

/** The SDK's warnings and errors, in our log, without the arguments it attaches (requests, responses). */
const sdkLogger = {
    error: (msg: string) => logger.error(msg, { component: 'anthropic-sdk' }),
    warn: (msg: string) => logger.warn(msg, { component: 'anthropic-sdk' }),
    info: (msg: string) => logger.info(msg, { component: 'anthropic-sdk' }),
    debug: (msg: string) => logger.debug(msg, { component: 'anthropic-sdk' }),
};

/**
 * The top-level body members a request may carry: what `callStructured`'s
 * builders write (and `stream`, which the SDK adds). Everything else is
 * refused, so a member that asks Anthropic to hold state or call out
 * (`thread`, `container`, `mcp_servers`, `context_management`, …) is refused
 * without being named, and so is one a later API version adds.
 */
export const PERMITTED_BODY_MEMBERS: ReadonlySet<string> = new Set([
    'model',
    'max_tokens',
    'messages',
    'system',
    'stream',
    'output_config',
    'tools',
    'tool_choice',
]);

/** The members of `output_config` a request may carry. */
export const PERMITTED_OUTPUT_CONFIG_MEMBERS: ReadonlySet<string> = new Set(['format', 'effort']);

/**
 * The content block types a system prompt or a message may carry (a
 * `tool_result`'s own content: `text` only). Text, the model's own thinking
 * passed back, and the single-tool path's call and result. No `document`,
 * `image`, `container_upload`, `search_result` or server-tool block: a `url`
 * source is a fetch Anthropic makes on the call's behalf, and a `file` source
 * reads data the Files API stores.
 */
export const PERMITTED_CONTENT_BLOCK_TYPES: ReadonlySet<string> = new Set([
    'text',
    'thinking',
    'redacted_thinking',
    'tool_use',
    'tool_result',
]);

/** Why `messagesOnlyFor`'s middleware refused a request. */
export type RequestRefusal =
    | 'NOT_THE_PINNED_ORIGIN'
    | 'NOT_A_MESSAGES_CALL'
    | 'BETA_HEADER'
    | 'BODY_UNREADABLE'
    | 'SERVER_HELD_STATE'
    | 'CONTENT_BLOCK'
    | 'SERVER_TOOL';

/**
 * What one outbound request carried, as the log records it: the method, the
 * path and the body's top-level member NAMES. Never a value, so no author
 * text, model output or key reaches the log.
 */
export interface RequestShape {
    readonly method: string;
    readonly path: string;
    /** The JSON body's top-level member names, sorted. Empty when the body is not a JSON object. */
    readonly bodyKeys: readonly string[];
}

export interface InspectableRequest {
    readonly method?: string;
    readonly url: string;
    readonly body?: unknown;
    readonly headers?: Headers | Record<string, string>;
}

function headerOf(headers: InspectableRequest['headers'], name: string): string | null {
    if (!headers) return null;
    if (headers instanceof Headers) return headers.get(name);
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    return key ? headers[key] : null;
}

/**
 * The refusal and the shape of one request, from ONE parse of its body. Pure,
 * so every branch is unit-tested without a network. `allowedServerTools` are
 * the server tool types the client was built to allow (none in 2.1).
 */
export function inspectRequest(
    request: InspectableRequest,
    allowedServerTools: readonly string[] = [],
): { refusal: RequestRefusal | null; shape: RequestShape } {
    const url = new URL(request.url);
    const method = (request.method ?? 'GET').toUpperCase();
    let members: Record<string, unknown> | null = null;
    if (typeof request.body === 'string') {
        try {
            const parsed: unknown = JSON.parse(request.body);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) members = parsed as Record<string, unknown>;
        } catch {
            members = null;
        }
    }
    const bodyKeys = members ? Object.keys(members).sort() : [];
    const shape: RequestShape = { method, path: url.pathname, bodyKeys };
    return { refusal: refusalOf(url, method, headerOf(request.headers, 'anthropic-beta'), members, allowedServerTools), shape };
}

function refusalOf(
    url: URL,
    method: string,
    beta: string | null,
    members: Record<string, unknown> | null,
    allowedServerTools: readonly string[],
): RequestRefusal | null {
    if (url.origin !== ANTHROPIC_API_BASE_URL) return 'NOT_THE_PINNED_ORIGIN';
    // `?beta=true` is the SDK's beta endpoint: no query string at all.
    if (method !== 'POST' || url.pathname !== MESSAGES_PATH || url.search !== '') return 'NOT_A_MESSAGES_CALL';
    if (beta !== null && beta.trim() !== '') return 'BETA_HEADER';
    if (!members) return 'BODY_UNREADABLE';
    if (Object.keys(members).some((name) => !PERMITTED_BODY_MEMBERS.has(name))) return 'SERVER_HELD_STATE';
    const outputConfig = members.output_config;
    if (outputConfig !== undefined) {
        if (outputConfig === null || typeof outputConfig !== 'object' || Array.isArray(outputConfig)) return 'BODY_UNREADABLE';
        if (Object.keys(outputConfig).some((name) => !PERMITTED_OUTPUT_CONFIG_MEMBERS.has(name))) return 'SERVER_HELD_STATE';
    }
    const contentRefusal = contentRefusalOf(members.system, members.messages);
    if (contentRefusal) return contentRefusal;
    const tools = members.tools;
    if (tools !== undefined) {
        if (!Array.isArray(tools)) return 'BODY_UNREADABLE';
        const refused = tools.some((tool: unknown) => {
            if (tool === null || typeof tool !== 'object') return true;
            const type = (tool as { type?: unknown }).type;
            if (type === undefined || type === null || type === 'custom') return false;
            return typeof type !== 'string' || !allowedServerTools.includes(type);
        });
        if (refused) return 'SERVER_TOOL';
    }
    return null;
}

/** A block list (or a string) whose every block is of a permitted type; `nested` for a tool result's content. */
function blocksRefusal(content: unknown, nested: boolean): RequestRefusal | null {
    if (typeof content === 'string') return null;
    if (!Array.isArray(content)) return 'BODY_UNREADABLE';
    for (const block of content) {
        if (block === null || typeof block !== 'object' || Array.isArray(block)) return 'BODY_UNREADABLE';
        const type = (block as { type?: unknown }).type;
        if (typeof type !== 'string') return 'BODY_UNREADABLE';
        if (nested ? type !== 'text' : !PERMITTED_CONTENT_BLOCK_TYPES.has(type)) return 'CONTENT_BLOCK';
        if (type === 'tool_result') {
            const inner = (block as { content?: unknown }).content;
            if (inner !== undefined) {
                const refusal = blocksRefusal(inner, true);
                if (refusal) return refusal;
            }
        }
    }
    return null;
}

/** The system prompt's and every message's content, against `PERMITTED_CONTENT_BLOCK_TYPES`. */
function contentRefusalOf(system: unknown, messages: unknown): RequestRefusal | null {
    if (system !== undefined) {
        const refusal = blocksRefusal(system, false);
        if (refusal) return refusal;
    }
    if (!Array.isArray(messages)) return 'BODY_UNREADABLE';
    for (const message of messages) {
        if (message === null || typeof message !== 'object' || Array.isArray(message)) return 'BODY_UNREADABLE';
        const role = (message as { role?: unknown }).role;
        if (role !== 'user' && role !== 'assistant') return 'BODY_UNREADABLE';
        const refusal = blocksRefusal((message as { content?: unknown }).content, false);
        if (refusal) return refusal;
    }
    return null;
}

/** Runs before every request a client sends, retries included. */
function messagesOnlyFor(call: { readonly callId?: string }, allowedServerTools: readonly string[]): Middleware {
    return async (request, next) => {
        const inspected = inspectRequest(
            { method: request.method, url: request.url, body: request.body, headers: request.headers },
            allowedServerTools,
        );
        logger.debug('ai: request', {
            component: 'ai',
            callId: call.callId,
            method: inspected.shape.method,
            path: inspected.shape.path,
            bodyKeys: inspected.shape.bodyKeys,
            refused: inspected.refusal,
        });
        if (inspected.refusal) throw new AiRequestRefusedError(inspected.refusal);
        return next(request);
    };
}

export interface ClientOptions {
    /** Correlates the client's request log lines with the call record. */
    readonly callId?: string;
    /** Server tools this client may send, each from `PERMITTED_SERVER_TOOL_TYPES`. None in 2.1. */
    readonly serverTools?: readonly PermittedServerToolType[];
    /** The SDK's own per-request timeout; the caller's deadline signal is the real bound. */
    readonly timeoutMs?: number;
    /** TEST SEAM: replaces the network. No production caller passes it. */
    readonly fetch?: typeof fetch;
}

/** A new client for one call, or the named reason there is none. Never cached. */
export function clientForRun(opts: ClientOptions = {}): ClientChoice {
    // One reading of the configuration's refusals, shared with the features'
    // own pre-checks (`aiUnavailableReason`, `./config.ts`).
    const refusal = aiUnavailableReason(env);
    if (refusal) return { ok: false, reason: refusal };
    // The stubbed model (Phase 2.4, `./model-stub.ts`): the same client, the
    // same middleware, its fetch in place of the network. Never beside a key.
    const stub = stubModelActive(env);
    const apiKey = stub ? 'stubbed-model-no-key' : env.ANTHROPIC_API_KEY!.trim();
    const fetchImpl = opts.fetch ?? (stub ? (stubMessagesFetch as typeof fetch) : undefined);

    const allowed: readonly string[] = (opts.serverTools ?? []).filter((t) =>
        (PERMITTED_SERVER_TOOL_TYPES as readonly string[]).includes(t),
    );
    const client = new Anthropic({
        apiKey,
        authToken: null,
        baseURL: ANTHROPIC_API_BASE_URL,
        // A fresh object per client: no two clients share a headers map. The
        // only header added is the workspace an organisation-level key's
        // request belongs to, when one is configured (`./anthropic-workspace.ts`).
        defaultHeaders: anthropicWorkspaceHeaders(env.ANTHROPIC_WORKSPACE_ID),
        webhookKey: null,
        maxRetries: CLIENT_MAX_RETRIES,
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
        logLevel: 'warn',
        logger: sdkLogger,
        openTelemetry: { propagation: false, traces: { enabled: true, contentMode: 'metadata_only' } },
        middleware: [messagesOnlyFor(opts, allowed)],
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    return { ok: true, client };
}

/**
 * The structured-output feature's explicit complexity limits (Anthropic's
 * "Structured outputs" documentation, "Schema complexity limits", read
 * 2026-11-19): parameters not in `required`, and parameters using `anyOf` or
 * a type array, across the request's schemas. Past either the API answers 400.
 */
export const MAX_OPTIONAL_PARAMETERS = 24;
export const MAX_UNION_PARAMETERS = 16;

type SchemaNode = Record<string, unknown>;

const isNode = (v: unknown): v is SchemaNode => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every sub-schema of `node` (not `node` itself), by the keywords that hold schemas. */
function childSchemas(node: SchemaNode): SchemaNode[] {
    const out: SchemaNode[] = [];
    const take = (v: unknown) => {
        if (isNode(v)) out.push(v);
    };
    if (isNode(node.properties)) Object.values(node.properties).forEach(take);
    if (isNode(node.$defs)) Object.values(node.$defs).forEach(take);
    if (isNode(node.definitions)) Object.values(node.definitions).forEach(take);
    take(node.items);
    take(node.additionalProperties);
    for (const key of ['anyOf', 'allOf', 'oneOf', 'prefixItems'] as const) {
        const list = node[key];
        if (Array.isArray(list)) list.forEach(take);
    }
    return out;
}

function walkSchema(node: SchemaNode, visit: (n: SchemaNode) => void): void {
    visit(node);
    for (const child of childSchemas(node)) walkSchema(child, visit);
}

/** The `$ref`s a schema node and its sub-schemas make, not following them. */
function refsOf(node: SchemaNode): string[] {
    const refs: string[] = [];
    walkSchema(node, (n) => {
        if (typeof n.$ref === 'string') refs.push(n.$ref);
    });
    return refs;
}

/**
 * Refuse a schema the structured-output feature cannot take, as a
 * programming error at build (`AiPromptError`) rather than a 400 on every
 * call, or worse, a schema the transform quietly changes:
 *
 *   • the root is not an object (the single-tool path makes the schema a
 *     tool's `input_schema`, which must be one, and the path a call takes
 *     depends on the deployment's model, so the rule is the same for both);
 *   • an object with arbitrary keys (`z.record`, `propertyNames`,
 *     `patternProperties`): the API requires `additionalProperties: false`,
 *     so the transform turns a record into `{}` and the model can only ever
 *     answer an empty one;
 *   • a recursive schema, or a `$ref` outside the schema: not supported;
 *   • more optional or union parameters than the documented limits.
 */
export function assertStructuredOutputSchema(raw: SchemaNode, transformed: SchemaNode): void {
    if (transformed.type !== 'object') throw new AiPromptError('an output schema must be an object at its root');
    walkSchema(raw, (n) => {
        if ('propertyNames' in n || 'patternProperties' in n) {
            throw new AiPromptError('an output schema may not hold an object with arbitrary keys (a record)');
        }
    });
    const defs: Record<string, SchemaNode> = isNode(transformed.$defs) ? (transformed.$defs as Record<string, SchemaNode>) : {};
    const target = (ref: string): string => {
        if (ref === '#') return '#';
        const m = /^#\/\$defs\/([^/]+)$/.exec(ref);
        if (!m || !(m[1] in defs)) throw new AiPromptError('an output schema may only refer to its own definitions');
        return m[1];
    };
    const rootBody: SchemaNode = { ...transformed };
    delete rootBody.$defs;
    const edges = (name: string): string[] => refsOf(name === '#' ? rootBody : defs[name]).map(target);
    const onPath = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string): void => {
        if (onPath.has(name)) throw new AiPromptError('an output schema may not be recursive');
        if (done.has(name)) return;
        onPath.add(name);
        for (const next of edges(name)) visit(next);
        onPath.delete(name);
        done.add(name);
    };
    visit('#');
    let optional = 0;
    let unions = 0;
    walkSchema(transformed, (n) => {
        if (Array.isArray(n.anyOf) || Array.isArray(n.type)) unions += 1;
        if (isNode(n.properties)) {
            const required = new Set(Array.isArray(n.required) ? n.required : []);
            optional += Object.keys(n.properties).filter((k) => !required.has(k)).length;
        }
    });
    if (optional > MAX_OPTIONAL_PARAMETERS) throw new AiPromptError(`an output schema has more than ${MAX_OPTIONAL_PARAMETERS} optional parameters`);
    if (unions > MAX_UNION_PARAMETERS) throw new AiPromptError(`an output schema has more than ${MAX_UNION_PARAMETERS} union parameters`);
}

/**
 * The JSON schema the API is given for `schema`, in the form its
 * structured-output feature accepts. This is what the SDK's `zodOutputFormat`
 * helper does (Zod's JSON schema, then the SDK's `transformJSONSchema`, which
 * moves constraints the API does not enforce — lengths, numeric bounds — into
 * descriptions and sets `additionalProperties: false`), with Zod's `$schema`
 * dialect member dropped first, so it is not folded into the root's
 * description, and the result checked against what the feature takes
 * (`assertStructuredOutputSchema`). Zod enforces every constraint on the
 * answer. The same schema is the single tool's `input_schema` on the tool
 * path.
 */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
    const raw: Record<string, unknown> = { ...z.toJSONSchema(schema, { reused: 'ref' }) };
    delete raw.$schema;
    const transformed = transformJSONSchema(raw) as Record<string, unknown>;
    assertStructuredOutputSchema(raw, transformed);
    return transformed;
}

/** What an error thrown by an SDK call was, without reading its message (which may quote the request). */
export type SdkErrorKind =
    | { kind: 'aborted' }
    | { kind: 'connection' }
    | { kind: 'api'; status: number | null; type: string | null }
    | { kind: 'refused'; refusal: string }
    | { kind: 'other' };

export function classifySdkError(err: unknown): SdkErrorKind {
    if (err instanceof AiRequestRefusedError) return { kind: 'refused', refusal: err.refusal };
    if (err instanceof APIUserAbortError) return { kind: 'aborted' };
    // The middleware's refusal surfaces wrapped as a connection error in some
    // SDK paths; its cause is the refusal.
    if (err instanceof APIConnectionError) {
        const cause = (err as { cause?: unknown }).cause;
        if (cause instanceof AiRequestRefusedError) return { kind: 'refused', refusal: cause.refusal };
        return { kind: 'connection' };
    }
    if (err instanceof APIError) {
        const body = err.error as { error?: { type?: unknown } } | undefined;
        const type = typeof body?.error?.type === 'string' ? body.error.type : null;
        return { kind: 'api', status: typeof err.status === 'number' ? err.status : null, type };
    }
    return { kind: 'other' };
}
