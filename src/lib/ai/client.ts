/**
 * THE ONE PLACE AN ANTHROPIC CLIENT IS BUILT (roadmap rule 3).
 *
 * Lifted from inflect-compliance's `src/lib/agentic/tool-runner/client.ts`
 * (see docs/carve-manifest.md). Inflect chose the client from a tenant's
 * residency terms and added a workspace header; Inkquisitor has one route to
 * one provider, so both branches are gone. What stays is the part that keeps a
 * call honest: a new client per call, the environment pinned out, and a
 * middleware that lets nothing but a Messages call leave.
 *
 * `eslint.config.mjs` refuses a value import of any `@anthropic-ai/*` package
 * anywhere under `src/` except this file (`local/anthropic-client-single-seam`).
 * With the class importable in one file only, a second construction site
 * cannot exist. Type imports stay allowed. The other things this layer needs
 * from the SDK at run time — the JSON schema of an output format and the
 * classification of an SDK error — are exported from here for that reason.
 *
 * ── WHEN THERE IS NO CLIENT ─────────────────────────────────────────────────
 *
 *   AI_DISABLED=1               refused first, before anything is read: the
 *                               global kill switch (`callStructured` asks it
 *                               earlier still; this is the backstop)
 *   no ANTHROPIC_API_KEY        refused, CREDENTIAL_NOT_CONFIGURED. The product
 *                               runs with AI off; production does not require
 *                               the key (`src/lib/startup-checks.ts`)
 *   ANTHROPIC_CUSTOM_HEADERS    refused, SDK_AMBIENT_HEADERS_SET (below)
 *
 * ── WHAT THE SDK WOULD OTHERWISE TAKE FROM THE ENVIRONMENT ─────────────────
 *
 * The SDK's constructor reads several `ANTHROPIC_*` variables on its own. Each
 * one that would change where author text goes, or who sees it, is pinned
 * here rather than left to whatever the process environment holds:
 *
 *   ANTHROPIC_BASE_URL       → `baseURL` is pinned to Anthropic's API, so the
 *                              host a call reaches is decided in code
 *   ANTHROPIC_LOG            → `logLevel` is pinned to 'warn'; at 'debug' the
 *                              SDK logs requests, which carry author text.
 *                              Its logger is ours, and drops the arguments
 *   ANTHROPIC_OPEN_TELEMETRY_* → tracing is pinned to `metadata_only`, so no
 *                              span carries message content; no trace context
 *                              is sent to Anthropic
 *   ANTHROPIC_WEBHOOK_SIGNING_KEY → `webhookKey` is null
 *   ANTHROPIC_AUTH_TOKEN and the credential chain → never read: passing
 *                              `apiKey` is the client's only credential
 *
 * One cannot be pinned: `ANTHROPIC_CUSTOM_HEADERS` is merged into every request
 * the client makes, and no option turns that off. A header set there — a beta
 * flag that stores conversations, say — would apply to every call without a
 * line of code saying so, so while it is set `clientForRun` refuses.
 *
 * ── WHAT A CLIENT MAY SEND ──────────────────────────────────────────────────
 *
 * The SDK reaches every Anthropic API: files, skills, batches, server-held
 * threads, Managed Agents. This layer needs one of them. Every client built
 * here carries `messagesOnlyFor`'s middleware, which runs before each request
 * leaves the process (retries included) and refuses (`requestRefusal`)
 * anything that is not:
 *
 *   • a POST to `/v1/messages` on the pinned origin; and
 *   • a body that asks Anthropic to hold nothing and call nothing on the
 *     call's behalf: no `thread`, no `container`, no `mcp_servers`, and no
 *     tool with a `type` other than `custom` (a server tool runs at Anthropic).
 *
 * Author text reaches the provider only under zero-retention terms (decision
 * D5); storing anything at Anthropic is a decision, so a widening here is that
 * decision's diff.
 *
 * ── THE TEST SEAM ───────────────────────────────────────────────────────────
 *
 * `fetch` replaces the network for tests (the SDK accepts a custom fetch, and
 * the middleware still runs in front of it). No production caller passes it.
 */
import Anthropic, { APIError, APIUserAbortError, type Middleware } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { AiRequestRefusedError, type AiUnavailableReason } from './errors';

/** The Messages API's origin. Pinned, so the environment cannot move the traffic. */
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';

/** The one API path a client may call. */
export const MESSAGES_PATH = '/v1/messages';

/** Retries the SDK makes on 408/409/429/5xx and connection errors (its own default, pinned). */
export const CLIENT_MAX_RETRIES = 2;

export type ClientChoice = { ok: true; client: Anthropic } | { ok: false; reason: AiUnavailableReason };

/** The SDK's warnings and errors, in our log, without the arguments it attaches (requests, responses). */
const sdkLogger = {
    error: (message: string) => logger.error(message, { component: 'anthropic-sdk' }),
    warn: (message: string) => logger.warn(message, { component: 'anthropic-sdk' }),
    info: (message: string) => logger.info(message, { component: 'anthropic-sdk' }),
    debug: (message: string) => logger.debug(message, { component: 'anthropic-sdk' }),
};

/** Body members that ask Anthropic to hold state or call out on the call's behalf. */
const REFUSED_BODY_MEMBERS = ['thread', 'container', 'mcp_servers'] as const;

/** Why `messagesOnlyFor`'s middleware refused a request. */
export type RequestRefusal =
    | 'NOT_THE_PINNED_ORIGIN'
    | 'NOT_A_MESSAGES_CALL'
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

/**
 * The refusal and the shape of one request, from ONE parse of its body. Pure,
 * so every branch is unit-tested without a network.
 */
export function inspectRequest(request: { method?: string; url: string; body?: unknown }): {
    refusal: RequestRefusal | null;
    shape: RequestShape;
} {
    const url = new URL(request.url);
    const method = (request.method ?? 'GET').toUpperCase();
    let body: unknown;
    let parsed = false;
    if (typeof request.body === 'string') {
        try {
            body = JSON.parse(request.body);
            parsed = true;
        } catch {
            parsed = false;
        }
    }
    const isObject = parsed && body !== null && typeof body === 'object' && !Array.isArray(body);
    const members = isObject ? (body as Record<string, unknown>) : null;
    const bodyKeys = members ? Object.keys(members).sort() : [];
    return { refusal: refusalOf(url, method, members), shape: { method, path: url.pathname, bodyKeys } };
}

/** The reason a request may not leave, given its parsed parts. */
function refusalOf(url: URL, method: string, members: Record<string, unknown> | null): RequestRefusal | null {
    if (url.origin !== ANTHROPIC_API_BASE_URL) return 'NOT_THE_PINNED_ORIGIN';
    if (method !== 'POST' || url.pathname !== MESSAGES_PATH) return 'NOT_A_MESSAGES_CALL';
    if (!members) return 'BODY_UNREADABLE';
    // `null` is the explicit "none", the same as leaving the member out.
    if (REFUSED_BODY_MEMBERS.some((name) => members[name] != null)) return 'SERVER_HELD_STATE';
    const tools = members.tools;
    if (tools !== undefined) {
        if (!Array.isArray(tools)) return 'BODY_UNREADABLE';
        const serverTool = tools.some((tool: unknown) => {
            if (tool === null || typeof tool !== 'object') return true;
            const type = (tool as { type?: unknown }).type;
            return type !== undefined && type !== null && type !== 'custom';
        });
        if (serverTool) return 'SERVER_TOOL';
    }
    return null;
}

/** The reason a request may not leave a client, or null when it may. */
export function requestRefusal(request: { method?: string; url: string; body?: unknown }): RequestRefusal | null {
    return inspectRequest(request).refusal;
}

/** Runs before every request a client sends, retries included. */
function messagesOnlyFor(call: { readonly callId?: string }): Middleware {
    return async (request, next) => {
        const inspected = inspectRequest(request);
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
    /** TEST SEAM: replaces the network. No production caller passes it. */
    readonly fetch?: typeof fetch;
}

/**
 * A new client for one call, or the named reason there is none. Never cached:
 * no two calls ever share an instance.
 */
export function clientForRun(opts: ClientOptions = {}): ClientChoice {
    if (env.AI_DISABLED === '1') return { ok: false, reason: 'AI_DISABLED' };
    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return { ok: false, reason: 'CREDENTIAL_NOT_CONFIGURED' };
    if (env.ANTHROPIC_CUSTOM_HEADERS?.trim()) return { ok: false, reason: 'SDK_AMBIENT_HEADERS_SET' };

    const client = new Anthropic({
        apiKey,
        baseURL: ANTHROPIC_API_BASE_URL,
        // A fresh object per client: no two clients share a headers map.
        defaultHeaders: {},
        webhookKey: null,
        maxRetries: CLIENT_MAX_RETRIES,
        logLevel: 'warn',
        logger: sdkLogger,
        openTelemetry: { propagation: false, traces: { enabled: true, contentMode: 'metadata_only' } },
        middleware: [messagesOnlyFor(opts)],
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    return { ok: true, client };
}

/**
 * The JSON schema the API is given for `schema`, in the form its
 * structured-output feature accepts (constraints it does not enforce, such as
 * `minLength`, are moved into descriptions; Zod enforces them on the answer).
 * The same schema is the forced tool's `input_schema` on the tool path.
 */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
    // `zodOutputFormat` also returns a `parse` function; only the schema is
    // kept, so the request body carries nothing the SDK would act on.
    return { ...zodOutputFormat(schema).schema };
}

/** What an error thrown by an SDK call was, without reading its message (which may quote the request). */
export type SdkErrorKind =
    | { kind: 'aborted' }
    | { kind: 'api'; status: number | null; type: string | null }
    | { kind: 'other' };

export function classifySdkError(err: unknown): SdkErrorKind {
    if (err instanceof APIUserAbortError) return { kind: 'aborted' };
    if (err instanceof APIError) {
        const body = err.error as { error?: { type?: unknown } } | undefined;
        const type = typeof body?.error?.type === 'string' ? body.error.type : null;
        return { kind: 'api', status: typeof err.status === 'number' ? err.status : null, type };
    }
    return { kind: 'other' };
}
