/**
 * What a log line may never carry — one list, two loggers.
 *
 * The Node logger (`./logger.ts`, pino) and the edge logger
 * (`./edge-logger.ts`, JSON on the console) both redact by FIELD NAME from
 * `REDACTED_KEYS`. Two lists would drift, and the edge one is the one nobody
 * would remember to update.
 *
 * Two classes of name are here:
 *
 *   - CREDENTIALS: authorization headers, cookies, passwords, tokens, keys.
 *     The inflect-compliance list, minus its directory-identifier names.
 *   - AUTHOR TEXT (roadmap rule 4): `text`, `answer`, `content`, `body` and
 *     their plurals. An author's answers and bible entries are private data
 *     that never reach a log line. The names are generic on purpose: a
 *     request body, a question's answer and a bible field's content all
 *     arrive under one of them, and a false positive costs a `[Redacted]` in
 *     a debug line while a false negative costs a manuscript in the log
 *     aggregator.
 *
 * Redaction is the SECOND line. The first is never passing the value at all
 * (ESLint `local/no-raw-prompt-logging` refuses a content-named field at a
 * log call under `src/`), and the logger never logs request bodies.
 *
 * Matching is by name, case-insensitively, at any depth, on BOTH loggers:
 * the edge logger runs `redactFields` over its fields, and the Node logger
 * runs `redactLogObject` in pino's `formatters.log` / `formatters.bindings`
 * hooks, before serialisation. pino's own `redact` (`PINO_REDACT_PATHS`) is
 * kept as a fast path for the shallow, common spellings, but it is literal
 * and case-sensitive, so it is never what the guarantee rests on.
 */

export const REDACT_CENSOR = '[Redacted]';

export const REDACTED_KEYS: readonly string[] = [
    // ── Credentials ──
    'authorization',
    'Authorization',
    'cookie',
    'Cookie',
    'cookies',
    'set-cookie',
    'Set-Cookie',
    'x-api-key',
    'password',
    'newPassword',
    'currentPassword',
    'passwd',
    'secret',
    'token',
    'accessToken',
    'refreshToken',
    'idToken',
    'sessionToken',
    'apiKey',
    'api_key',
    'clientSecret',
    'privateKey',
    // OAuth's snake_case spellings, as token endpoints and providers send them.
    'access_token',
    'refresh_token',
    'id_token',
    'client_secret',
    // ── Author text (roadmap rule 4) ──
    'text',
    'texts',
    'answer',
    'answers',
    'content',
    'contents',
    'body',
    'bodies',
];

const LOWERCASE_KEYS = new Set(REDACTED_KEYS.map((k) => k.toLowerCase()));

/** True when a field of this name is never written to a log line. */
export function isRedactedKey(key: string): boolean {
    return LOWERCASE_KEYS.has(key.toLowerCase());
}

/**
 * pino's redaction paths — the FAST PATH only: every listed spelling at the
 * root, one level down and two levels down. pino matches literal,
 * case-sensitive paths, so a deeper or differently cased field is caught by
 * `redactLogObject` in the logger's formatters instead.
 */
function pathFor(key: string): string {
    return /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
}

export const PINO_REDACT_PATHS: readonly string[] = REDACTED_KEYS.flatMap((key) => {
    const p = pathFor(key);
    const joined = p.startsWith('[') ? p : `.${p}`;
    return [p, `*${joined}`, `*.*${joined}`];
});

/** How deep either logger walks; anything deeper is replaced, never written. */
export const REDACT_MAX_DEPTH = 8;

/**
 * Return a copy of `value` with every redacted key replaced by the censor, at
 * any depth up to `maxDepth` (deeper values become `[Truncated]`, so a cycle
 * or a huge structure cannot carry a field past the walk). Used by the edge
 * logger, which has no pino. An Error becomes its name and message.
 */
export function redactFields(value: unknown, maxDepth = REDACT_MAX_DEPTH): unknown {
    if (maxDepth < 0) return '[Truncated]';
    if (Array.isArray(value)) return value.map((v) => redactFields(v, maxDepth - 1));
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Error) return { name: value.name, message: value.message };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = isRedactedKey(k) ? REDACT_CENSOR : redactFields(v, maxDepth - 1);
    }
    return out;
}

/**
 * The Node logger's walk: the same names, case-insensitively, at any depth up
 * to `maxDepth`. It differs from `redactFields` in one way: an Error is left
 * for pino's `err` serializer, with any redacted own property (a `body` an
 * HTTP client attached, say) censored on a shallow copy first.
 */
export function redactLogObject(value: unknown, maxDepth = REDACT_MAX_DEPTH): unknown {
    if (maxDepth < 0) return '[Truncated]';
    if (Array.isArray(value)) return value.map((v) => redactLogObject(v, maxDepth - 1));
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Error) {
        const own = Object.keys(value);
        if (!own.some((k) => isRedactedKey(k))) return value;
        const copy = Object.create(Object.getPrototypeOf(value)) as Error & Record<string, unknown>;
        for (const k of Object.getOwnPropertyNames(value)) {
            copy[k] = isRedactedKey(k) ? REDACT_CENSOR : (value as unknown as Record<string, unknown>)[k];
        }
        return copy;
    }
    if (value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = isRedactedKey(k) ? REDACT_CENSOR : redactLogObject(v, maxDepth - 1);
    }
    return out;
}
