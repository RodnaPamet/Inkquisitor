/**
 * THE STUBBED MODEL (Phase 2.4) — a deterministic stand-in for Anthropic's
 * Messages API, for a server that must run the interview end to end with no
 * provider: the E2E run of a whole session (`tests/e2e/interview-session.spec.ts`)
 * and a developer's machine without a key.
 *
 * ═══ WHAT IT IS, AND WHAT IT IS NOT ═══
 *
 * It is a `fetch`. `clientForRun` (`./client.ts`, still the one file that
 * loads the SDK) hands it to the SDK in place of the network when
 * `AI_MODEL_STUB=1`, exactly where tests hand their fake (`ClientOptions.fetch`).
 * So everything above the wire runs for real: the request builder and its
 * fence, the guard, the messages-only middleware (which still refuses anything
 * but a Messages call to the pinned origin), the SDK's stream parser, the
 * output validation, the spend ceiling and the `AiCallLog` record. Nothing
 * leaves the process.
 *
 * It is NOT a production mode. `stubModelProblems` (below; asked by the
 * start-up check, `src/lib/startup-checks.ts`, on the web tier and the worker)
 * refuses a production process that sets it unless that process is plainly
 * a local test server: `APP_URL` and `NEXTAUTH_URL` both set to a loopback
 * address, and no `ANTHROPIC_API_KEY` beside it. A real deployment has a
 * public `APP_URL`, so it cannot run with the stub on; and a stub can never
 * stand in for a configured provider. Every start with it on logs a WARN.
 *
 * ═══ HOW IT ANSWERS ═══
 *
 * It reads the request the SDK sent, as the tests' fake does
 * (`tests/helpers/fake-question-model.ts`): the fenced `targets.N` blocks of
 * the user turn and the question kinds the system prompt allows, and words one
 * plain, neutral question per allowed target (a recommendation on a pick, so
 * "accept the suggestion" has something to accept). It invents no story
 * content: every question asks about the field by the field's own key. A
 * `previous-wording` block (a rephrase) gets the same target asked another
 * way, in another kind where the dial allows one. A request it cannot read is
 * answered with no question at all, which the engine treats as an empty
 * answer, never as content.
 */
import type { AiEnvRecord } from './config';

/** How long the stub takes to answer (ms): long enough for a stream to show its progress, short enough for a test. */
export const STUB_LATENCY_MS = 250;

type Kind = 'OPEN' | 'CHOICE' | 'EITHER_OR' | 'SCENARIO' | 'SCALE';
const KIND_ORDER: readonly Kind[] = ['CHOICE', 'OPEN', 'SCALE', 'EITHER_OR', 'SCENARIO'];

const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** Is the stubbed model switched on? Only the exact value `1`. */
export function stubModelEnabled(e: Pick<AiEnvRecord, 'AI_MODEL_STUB'>): boolean {
    return e.AI_MODEL_STUB?.trim() === '1';
}

/** A loopback host: `localhost`, `127.0.0.0/8`, `::1`. */
export function isLoopbackUrl(raw: string | undefined): boolean {
    if (!present(raw)) return false;
    try {
        const host = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase();
        return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
    } catch {
        return false;
    }
}

/**
 * Why this environment may not run the stub. Empty when it may (or when it is
 * off). In production the stub needs a process that is plainly a local test
 * server; anywhere, it never sits beside a provider key.
 */
export function stubModelProblems(e: AiEnvRecord & { readonly APP_URL?: string; readonly NEXTAUTH_URL?: string }): string[] {
    const raw = e.AI_MODEL_STUB;
    if (!present(raw) || raw.trim() === '0') return [];
    if (raw.trim() !== '1') return ['AI_MODEL_STUB must be 1 or unset.'];
    const problems: string[] = [];
    if (present(e.ANTHROPIC_API_KEY)) {
        problems.push('AI_MODEL_STUB=1 is set beside ANTHROPIC_API_KEY: the stubbed model never stands in for a configured provider. Unset one.');
    }
    if (e.NODE_ENV === 'production' && !(isLoopbackUrl(e.APP_URL) && isLoopbackUrl(e.NEXTAUTH_URL))) {
        problems.push(
            'AI_MODEL_STUB=1 answers every model call with canned questions, for a local test server only: in production it needs ' +
                'APP_URL and NEXTAUTH_URL both set to a loopback address (localhost, 127.0.0.1, ::1). Unset AI_MODEL_STUB.',
        );
    }
    return problems;
}

// ─── The answer ─────────────────────────────────────────────────────

interface Targets {
    elementId: string;
    allowed_targets: string[];
}

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n');
    return '';
}

/** The fenced data blocks of the request's first user turn, by label. */
function fencedBlocks(body: Record<string, unknown>): Map<string, string> {
    const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: unknown; content?: unknown }>) : [];
    const user = textOf(messages.find((m) => m.role === 'user')?.content);
    const out = new Map<string, string>();
    for (const m of user.matchAll(/<author_data_([0-9a-f]{32}) label="([^"]+)">\n([\s\S]*?)\n<\/author_data_\1>/g)) out.set(m[2], m[3]);
    return out;
}

/** A small, stable number from a string (which kind a field's question takes). */
function spread(s: string): number {
    let h = 0;
    for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h;
}

function words(fieldKey: string): string {
    return fieldKey.split('_').join(' ');
}

function question(elementId: string, fieldKey: string, kind: Kind, rephrase: boolean): Record<string, unknown> {
    const w = words(fieldKey);
    const base = { elementId, targetsFieldKeys: [fieldKey], mode: 'FRONTIER', kind, rationale: `Asks for the ${w}.` };
    const lead = rephrase ? 'Seen from a reader’s side, ' : '';
    switch (kind) {
        case 'OPEN':
            return { ...base, text: rephrase ? `${lead}how would you sum up the ${w} in a sentence or two?` : `What matters most about the ${w}, in your own words?` };
        case 'SCENARIO':
            return { ...base, text: rephrase ? `${lead}picture a scene that turns on the ${w}: what does it show?` : `Imagine a scene where the ${w} is tested: what happens there?` };
        case 'SCALE':
            return {
                ...base,
                text: rephrase ? `${lead}how loudly should the ${w} come through?` : `How strongly does the ${w} weigh on this?`,
                scaleLabels: { low: 'barely', high: 'completely' },
                recommendedAnswer: 3,
                recommendationBasis: { fieldKeys: [], answerIds: [] },
            };
        case 'EITHER_OR': {
            const options = [`The ${w} stays hidden`, `The ${w} is out in the open`];
            return { ...base, text: rephrase ? `${lead}is the ${w} kept quiet or shown?` : `Which way does the ${w} go?`, options, recommendedAnswer: options[0], recommendationBasis: { fieldKeys: [], answerIds: [] } };
        }
        case 'CHOICE': {
            const options = [`The ${w} is settled early`, `The ${w} shifts midway`, `The ${w} is revealed late`];
            return {
                ...base,
                text: rephrase ? `${lead}when does the ${w} come into focus?` : `How does the ${w} take shape?`,
                options,
                recommendedAnswer: options[1],
                recommendationBasis: { fieldKeys: [], answerIds: [] },
            };
        }
    }
}

/** The stub's structured answer to one Messages request body. Pure. */
export function stubAnswer(body: Record<string, unknown>): { questions: Array<Record<string, unknown>>; declined: [] } {
    const system = textOf(body.system);
    const allowed = (/Use only these question kinds: ([A-Z_, ]+)\./.exec(system)?.[1].split(', ') ?? []) as Kind[];
    const kinds = KIND_ORDER.filter((k) => allowed.includes(k));
    if (kinds.length === 0) return { questions: [], declined: [] };
    const blocks = fencedBlocks(body);
    let previousKind: string | null = null;
    const previous = blocks.get('previous-wording');
    if (previous !== undefined) {
        try {
            previousKind = String((JSON.parse(previous) as { kind?: unknown }).kind ?? '');
        } catch {
            return { questions: [], declined: [] };
        }
    }
    const questions: Array<Record<string, unknown>> = [];
    for (const [label, text] of blocks) {
        if (!label.startsWith('targets.')) continue;
        let t: Targets;
        try {
            t = JSON.parse(text) as Targets;
        } catch {
            continue;
        }
        for (const key of Array.isArray(t.allowed_targets) ? t.allowed_targets : []) {
            let kind = kinds[spread(key) % kinds.length];
            if (previousKind !== null) kind = kinds.find((k) => k !== previousKind) ?? kind;
            questions.push(question(t.elementId, key, kind, previousKind !== null));
        }
    }
    return { questions: questions.slice(0, 12), declined: [] };
}

function sse(events: Array<Record<string, unknown>>): string {
    return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** The Messages API's streamed reply carrying `text`. */
function streamedMessage(model: string, text: string, usage: { input_tokens: number; output_tokens: number }): string {
    return sse([
        { type: 'message_start', message: { id: 'msg_stub', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
        { type: 'message_stop' },
    ]);
}

function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                reject(signal.reason ?? new Error('aborted'));
            },
            { once: true },
        );
    });
}

/** THE stub, as the `fetch` the SDK is handed. Answers after `STUB_LATENCY_MS`; honours the request's abort. */
export async function stubMessagesFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    await wait(STUB_LATENCY_MS, init?.signal);
    let body: Record<string, unknown> = {};
    try {
        body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    } catch {
        body = {};
    }
    const model = typeof body.model === 'string' ? body.model : 'stub-model';
    const text = JSON.stringify(stubAnswer(body));
    return new Response(streamedMessage(model, text, { input_tokens: 1_500, output_tokens: Math.max(50, Math.ceil(text.length / 4)) }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    });
}
