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
 * answer, never as content. A RECONCILE request (Phase 2.5) is answered by
 * `stubReconcileAnswer`: an ADD of the author's own words into each empty
 * field an answer targeted, NO_CHANGE everywhere else, nothing invented.
 * The RESEARCH agent's requests (Phase 2.6) are answered from a fake web, with
 * no network: a gather turn runs one web search and one fetch of a page built
 * from the brief's question alone (`stubWebPage`), streamed as the server
 * tools' own blocks; the findings call quotes each source's first sentence;
 * the fit call proposes that claim for the first empty field of the first
 * scope element. The product's validation still judges every word.
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
 * THE LOOPBACK-ONLY STUB (decision D13, 2026-11-20): the stubbed model is
 * switched on, no provider key sits beside it, and `APP_URL` and
 * `NEXTAUTH_URL` are BOTH loopback addresses — a local test server, never a
 * real deployment (whose public `APP_URL` every link is built from). It is the
 * only production configuration the stub may run in (`stubModelProblems`
 * refuses every other), and the only one in which the pack mount gate also
 * accepts structural evaluation records (`packRecordModeOf`,
 * `src/lib/interview/pack-records-config.ts`), so the stub E2E server can run
 * interviews against the production build. Pure.
 */
export function loopbackStubMode(e: Pick<AiEnvRecord, 'AI_MODEL_STUB' | 'ANTHROPIC_API_KEY' | 'APP_URL' | 'NEXTAUTH_URL'>): boolean {
    return stubModelEnabled(e) && !present(e.ANTHROPIC_API_KEY) && isLoopbackUrl(e.APP_URL) && isLoopbackUrl(e.NEXTAUTH_URL);
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

// ─── The reconcile step (Phase 2.5) ─────────────────────────────────

interface StubScopeElement {
    elementId?: unknown;
    scope_field_keys?: unknown;
    fields?: Array<{ key?: unknown; type?: unknown }>;
    stored_values?: Record<string, unknown>;
}

interface StubAnswer {
    answerId?: unknown;
    elementId?: unknown;
    targetsFieldKeys?: unknown;
    status?: unknown;
    answer?: unknown;
}

/**
 * The stub's answer to a RECONCILE request (Phase 2.5: `element.N` blocks
 * with `scope_field_keys`, and an `answers` block). Conservative and
 * deterministic: an EMPTY scope field that an ANSWERED answer targeted gets
 * an ADD of that answer's own words (a list one item, a scale the answer's
 * number), citing it; every other field NO_CHANGE; no new element. It never
 * updates or removes and invents nothing — the product's validation still
 * judges every word. Pure.
 *
 * Phase 3.3 (D24), so the canvas E2E can walk a proposal to a ghost and back:
 * a request offering `relation-ends` (a selection) proposes ONE `related_to`
 * link between its first two ends, its nature the first answer's own words,
 * citing every answer; a request with a `slot` (between two beats) proposes
 * the slot's new element, named by the first four words of the first answer
 * about it, and a `causes` link from the earlier neighbour to it and from it to
 * the later one, each in an answer's own words. Validation judges all of it.
 */
export function stubReconcileAnswer(body: Record<string, unknown>): { operations: Array<Record<string, unknown>>; newElements: Array<Record<string, unknown>>; newRelations: Array<Record<string, unknown>> } | null {
    const blocks = fencedBlocks(body);
    const answersText = blocks.get('answers');
    if (answersText === undefined) return null;
    let answers: StubAnswer[];
    try {
        answers = JSON.parse(answersText) as StubAnswer[];
    } catch {
        return { operations: [], newElements: [], newRelations: [] };
    }
    const operations: Array<Record<string, unknown>> = [];
    for (const [label, text] of blocks) {
        if (!label.startsWith('element.')) continue;
        let e: StubScopeElement;
        try {
            e = JSON.parse(text) as StubScopeElement;
        } catch {
            continue;
        }
        const keys = Array.isArray(e.scope_field_keys) ? e.scope_field_keys.filter((k): k is string => typeof k === 'string') : [];
        for (const key of keys) {
            const type = e.fields?.find((f) => f.key === key)?.type;
            const stored = e.stored_values?.[key];
            const source = answers.find(
                (a) => a.status === 'ANSWERED' && a.elementId === e.elementId && Array.isArray(a.targetsFieldKeys) && a.targetsFieldKeys.includes(key) && (typeof a.answer === 'string' || typeof a.answer === 'number'),
            );
            const reply = source?.answer;
            let value: string | string[] | number | null = null;
            if (type === 'scale') value = typeof reply === 'number' ? reply : null;
            else if (type === 'list') value = typeof reply === 'string' ? [reply] : null;
            else if (type !== 'choice') value = typeof reply === 'string' ? reply : typeof reply === 'number' ? String(reply) : null;
            if (stored === null && value !== null && source) operations.push({ elementId: e.elementId, fieldKey: key, op: 'ADD', value, cites: [source.answerId] });
            else operations.push({ elementId: e.elementId, fieldKey: key, op: 'NO_CHANGE', value: null, cites: [] });
        }
    }
    const answered = answers.filter((a): a is StubAnswer & { answerId: string; answer: string } => a.status === 'ANSWERED' && typeof a.answerId === 'string' && typeof a.answer === 'string' && a.answer.trim() !== '');
    const newElements: Array<Record<string, unknown>> = [];
    const newRelations: Array<Record<string, unknown>> = [];
    let ends: Array<{ elementId?: unknown }> = [];
    try {
        ends = JSON.parse(blocks.get('relation-ends') ?? '[]') as Array<{ elementId?: unknown }>;
    } catch {
        ends = [];
    }
    let slot: { kind?: unknown } | null = null;
    try {
        slot = blocks.has('slot') ? (JSON.parse(blocks.get('slot')!) as { kind?: unknown }) : null;
    } catch {
        slot = null;
    }
    if (slot && typeof slot.kind === 'string' && ends.length >= 2) {
        const about = answered.find((a) => a.elementId === 'pending-element') ?? answered[0];
        if (about) {
            const name = about.answer.split(/\s+/).slice(0, 4).join(' ').replace(/[.,;:!?]+$/, '');
            newElements.push({ kind: slot.kind, name, summary: null, fillsSlot: true, cites: [about.answerId] });
            const words = (i: number) => answered[Math.min(i, answered.length - 1)];
            newRelations.push({ fromElementId: ends[0].elementId, toElementId: 'new.1', type: 'causes', note: null, fields: [{ key: 'mechanism', value: words(1).answer }], cites: [words(1).answerId] });
            newRelations.push({ fromElementId: 'new.1', toElementId: ends[1].elementId, type: 'causes', note: null, fields: [{ key: 'mechanism', value: words(2).answer }], cites: [words(2).answerId] });
        }
    } else if (ends.length >= 2 && answered.length > 0) {
        newRelations.push({
            fromElementId: ends[0].elementId,
            toElementId: ends[1].elementId,
            type: 'related_to',
            note: null,
            fields: [{ key: 'nature', value: answered[0].answer }],
            cites: answered.map((a) => a.answerId),
        });
    }
    return { operations: operations.slice(0, 40), newElements, newRelations };
}

// ─── The research agent (Phase 2.6) ────────────────────────────────

/** The stub's fake web: one page per question, under a reserved `.example` name, its text built from the question alone. */
export const STUB_WEB_ORIGIN = 'https://research.stub.example';

function stubTopic(question: string): string {
    return question.replace(/[?!.]+\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'the topic';
}

/** The page the stub's web holds for a question (deterministic; no network). */
export function stubWebPage(question: string): { url: string; title: string; text: string } {
    const topic = stubTopic(question);
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'topic';
    return {
        url: `${STUB_WEB_ORIGIN}/${slug}`,
        title: `Notes on ${topic}`,
        text: `Historical records describe ${topic} in careful detail. Archives hold several firsthand accounts of ${topic}. Scholars agree on the main facts about ${topic}.`,
    };
}

/**
 * The stub's answer to a research GATHER request (the web tools offered): one
 * web search for the brief's question, its one hit fetched — both server tool
 * blocks and their results, as the Messages API streams them — then a short
 * closing text. Built from the brief's question block alone.
 */
function stubGatherEvents(body: Record<string, unknown>, model: string): Array<Record<string, unknown>> | null {
    const tools = Array.isArray(body.tools) ? (body.tools as Array<{ type?: unknown }>) : [];
    if (!tools.some((t) => t.type === 'web_search_20260209')) return null;
    const question = fencedBlocks(body).get('brief.question') ?? '';
    const page = stubWebPage(question);
    const query = stubTopic(question).split(' ').slice(0, 8).join(' ');
    const usage = { input_tokens: 2_000, output_tokens: 1 };
    return [
        { type: 'message_start', message: { id: 'msg_stub_gather', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } },
        { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_stub_1', name: 'web_search', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } },
        { type: 'content_block_stop', index: 0 },
        {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_stub_1', content: [{ type: 'web_search_result', url: page.url, title: page.title, encrypted_content: 'stub', page_age: null }] },
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'server_tool_use', id: 'srvtoolu_stub_2', name: 'web_fetch', input: {} } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ url: page.url }) } },
        { type: 'content_block_stop', index: 2 },
        {
            type: 'content_block_start',
            index: 3,
            content_block: {
                type: 'web_fetch_tool_result',
                tool_use_id: 'srvtoolu_stub_2',
                content: { type: 'web_fetch_result', url: page.url, retrieved_at: '2026-11-20T00:00:00Z', content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: page.text }, title: page.title, citations: null } },
            },
        },
        { type: 'content_block_stop', index: 3 },
        { type: 'content_block_start', index: 4, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 4, delta: { type: 'text_delta', text: `Read ${page.title}.` } },
        { type: 'content_block_stop', index: 4 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 60, server_tool_use: { web_search_requests: 1, web_fetch_requests: 1 } } },
        { type: 'message_stop' },
    ];
}

/** The stub's FINDINGS answer: each source's first sentence as a claim, quoted verbatim from it. Pure. */
export function stubFindingsAnswer(body: Record<string, unknown>): { findings: Array<Record<string, unknown>> } | null {
    const blocks = [...fencedBlocks(body)].filter(([label]) => label.startsWith('source.'));
    if (blocks.length === 0) return null;
    const findings: Array<Record<string, unknown>> = [];
    for (const [, text] of blocks) {
        let source: { ref?: unknown; text?: unknown };
        try {
            source = JSON.parse(text) as { ref?: unknown; text?: unknown };
        } catch {
            continue;
        }
        if (typeof source.ref !== 'string' || typeof source.text !== 'string') continue;
        const sentences = source.text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length >= 20);
        if (sentences.length === 0) continue;
        findings.push({ claim: sentences[0], summary: sentences.slice(0, 2).join(' '), confidence: 'MEDIUM', citations: [{ ref: source.ref, quote: sentences[0] }] });
    }
    return { findings: findings.slice(0, 3) };
}

/** The stub's FIT answer: the first finding as an ADD into the first empty text, rich-text or list field of the first scope element. Pure. */
export function stubFitAnswer(body: Record<string, unknown>): { proposals: Array<Record<string, unknown>>; noFit: Array<Record<string, unknown>> } | null {
    const blocks = fencedBlocks(body);
    const findings = [...blocks].filter(([label]) => label.startsWith('finding.')).map(([, t]) => {
        try {
            return JSON.parse(t) as { ref?: string; claim?: string };
        } catch {
            return {};
        }
    });
    if (findings.length === 0) return null;
    const first = findings[0];
    for (const [label, text] of blocks) {
        if (!label.startsWith('element.')) continue;
        let e: { elementId?: string; role?: string; fields?: Array<{ key?: string; type?: string }>; stored_values?: Record<string, unknown> };
        try {
            e = JSON.parse(text) as typeof e;
        } catch {
            continue;
        }
        if (e.role !== 'scope' || !e.elementId) continue;
        const field = (e.fields ?? []).find((f) => (f.type === 'text' || f.type === 'richtext' || f.type === 'list') && f.key && !(f.key in (e.stored_values ?? {})));
        if (!field || !first.claim || !first.ref) continue;
        return {
            proposals: [{ op: 'ADD', elementId: e.elementId, fieldKey: field.key, value: field.type === 'list' ? [first.claim] : first.claim, newKind: null, newName: null, newSummary: null, rationale: 'The finding bears on this entry.', cites: [first.ref] }],
            noFit: [],
        };
    }
    return { proposals: [], noFit: findings.filter((f) => f.ref).map((f) => ({ finding: f.ref, reason: 'No entry in scope has an empty field it fits.' })) };
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
    const gather = stubGatherEvents(body, model);
    if (gather) return new Response(sse(gather), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const text = JSON.stringify(stubFindingsAnswer(body) ?? stubFitAnswer(body) ?? stubReconcileAnswer(body) ?? stubAnswer(body));
    return new Response(streamedMessage(model, text, { input_tokens: 1_500, output_tokens: Math.max(50, Math.ceil(text.length / 4)) }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    });
}
