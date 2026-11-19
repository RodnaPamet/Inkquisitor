/**
 * THE ONE PLACE AN ANTHROPIC CLIENT IS BUILT (roadmap rule 3, Phase 2.1).
 *
 * Lifted from inflect-compliance's `src/lib/agentic/tool-runner/client.ts`
 * (see docs/carve-manifest.md). Inflect chose the client from a tenant's
 * residency terms and added a workspace header; Inkquisitor has one route to
 * one provider, so both branches are gone. What stays is what keeps a call
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
 *   production, no ANTHROPIC_ZDR_CONFIRMED=1
 *                               ZDR_NOT_CONFIRMED: decision D5. The start-up
 *                               check refuses the process first (`./config.ts`)
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
 *   • a POST to `/v1/messages` on the pinned origin, with no `anthropic-beta`
 *     header; and
 *   • a body that asks Anthropic to hold nothing and call nothing on the
 *     call's behalf: no `thread`, `container` or `mcp_servers`, and no tool
 *     whose `type` is not `custom` — unless that server tool's type is one the
 *     CLIENT was built to allow, and every type a client may be built to allow
 *     is in `PERMITTED_SERVER_TOOL_TYPES`.
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
 * middleware still runs in front of it). No production caller passes it.
 */
import Anthropic, { APIConnectionError, APIError, APIUserAbortError, type Middleware } from '@anthropic-ai/sdk';
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import { z } from 'zod';

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { aiDisabled, zdrConfirmed } from './config';
import { AiRequestRefusedError, type AiUnavailableReason } from './errors';

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

/** Body members that ask Anthropic to hold state or call out on the call's behalf. */
const REFUSED_BODY_MEMBERS = ['thread', 'container', 'mcp_servers'] as const;

/** Why `messagesOnlyFor`'s middleware refused a request. */
export type RequestRefusal =
    | 'NOT_THE_PINNED_ORIGIN'
    | 'NOT_A_MESSAGES_CALL'
    | 'BETA_HEADER'
    | 'BODY_UNREADABLE'
    | 'SERVER_HELD_STATE'
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
    if (method !== 'POST' || url.pathname !== MESSAGES_PATH) return 'NOT_A_MESSAGES_CALL';
    if (beta !== null && beta.trim() !== '') return 'BETA_HEADER';
    if (!members) return 'BODY_UNREADABLE';
    // `null` is the explicit "none", the same as leaving the member out.
    if (REFUSED_BODY_MEMBERS.some((name) => members[name] != null)) return 'SERVER_HELD_STATE';
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
    if (aiDisabled(env)) return { ok: false, reason: 'AI_DISABLED' };
    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return { ok: false, reason: 'CREDENTIAL_NOT_CONFIGURED' };
    if (env.ANTHROPIC_CUSTOM_HEADERS?.trim()) return { ok: false, reason: 'SDK_AMBIENT_HEADERS_SET' };
    if (env.NODE_ENV === 'production' && !zdrConfirmed(env)) return { ok: false, reason: 'ZDR_NOT_CONFIRMED' };

    const allowed: readonly string[] = (opts.serverTools ?? []).filter((t) =>
        (PERMITTED_SERVER_TOOL_TYPES as readonly string[]).includes(t),
    );
    const client = new Anthropic({
        apiKey,
        authToken: null,
        baseURL: ANTHROPIC_API_BASE_URL,
        // A fresh object per client: no two clients share a headers map.
        defaultHeaders: {},
        webhookKey: null,
        maxRetries: CLIENT_MAX_RETRIES,
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
        logLevel: 'warn',
        logger: sdkLogger,
        openTelemetry: { propagation: false, traces: { enabled: true, contentMode: 'metadata_only' } },
        middleware: [messagesOnlyFor(opts, allowed)],
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    return { ok: true, client };
}

/**
 * The JSON schema the API is given for `schema`, in the form its
 * structured-output feature accepts. This is what the SDK's `zodOutputFormat`
 * helper does (Zod's JSON schema, then the SDK's `transformJSONSchema`, which
 * moves constraints the API does not enforce — lengths, numeric bounds — into
 * descriptions and sets `additionalProperties: false`), with Zod's `$schema`
 * dialect member dropped first, so it is not folded into the root's
 * description. Zod enforces every constraint on the answer. The same schema
 * is the single tool's `input_schema` on the tool path.
 */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
    const raw: Record<string, unknown> = { ...z.toJSONSchema(schema, { reused: 'ref' }) };
    delete raw.$schema;
    return transformJSONSchema(raw) as Record<string, unknown>;
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
