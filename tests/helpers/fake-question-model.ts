/**
 * A fake MODEL for the question engine at the HTTP layer (Phase 2.2 wired to
 * 2.1): a turn of the fake Messages API (`./fake-anthropic.ts`) that reads the
 * request the SDK actually sent — the fenced `targets.N` blocks of the user
 * turn and the detail's kinds in the system prompt — and answers with one
 * well-formed question per allowed target, as the deterministic generator does
 * one layer up (`./fake-question-generator.ts`). So a test drives the WIRED
 * generator through the real `callStructured`: the real request builder, the
 * fence, the guard, the SDK, the middleware, the stream parser and the ledger.
 */
import type { GeneratedQuestion } from '@/lib/interview/candidates';
import type { QuestionKind } from '@/lib/interview/vocabulary';
import type { FakeTurn, Usage } from './fake-anthropic';
import { fakeQuestion } from './fake-question-generator';

interface AllowedTargets {
    elementId: string;
    allowed_targets: string[];
}

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n');
    return '';
}

/** The fenced blocks of a request body's first user turn, by label. */
export function fencedBlocks(body: Record<string, unknown>): Map<string, string> {
    const messages = (body.messages as Array<{ role: string; content: unknown }>) ?? [];
    const user = textOf(messages.find((m) => m.role === 'user')?.content);
    const out = new Map<string, string>();
    for (const m of user.matchAll(/<author_data_([0-9a-f]{32}) label="([^"]+)">\n([\s\S]*?)\n<\/author_data_\1>/g)) out.set(m[2], m[3]);
    return out;
}

/** The system prompt a request body carries, as one string. */
export function systemOf(body: Record<string, unknown>): string {
    return textOf(body.system);
}

export interface FakeQuestionModelOptions {
    /** Rewrite each question the fake model would send. */
    mutate?: (q: GeneratedQuestion) => GeneratedQuestion;
    /** What every answer reports as its usage (default 1 200 in, 300 out). */
    usage?: Usage;
}

/** The fake model's answer to one request body. */
export function questionModelAnswer(body: Record<string, unknown>, options: FakeQuestionModelOptions = {}): Extract<FakeTurn, { kind: 'text' }> {
    const kinds = (/Use only these question kinds: ([A-Z_, ]+)\./.exec(systemOf(body))?.[1].split(', ') ?? []) as QuestionKind[];
    const questions = [...fencedBlocks(body)]
        .filter(([label]) => label.startsWith('targets.'))
        .flatMap(([, text]) => {
            const t = JSON.parse(text) as AllowedTargets;
            return t.allowed_targets.map((key) => fakeQuestion(t.elementId, key, kinds));
        })
        .map((q) => (options.mutate ? options.mutate(q) : q));
    return { kind: 'text', text: JSON.stringify({ questions, declined: [] }), usage: options.usage ?? { input_tokens: 1_200, output_tokens: 300 } };
}

/** A turn that answers whatever it is asked, every time (a model with no end of script). */
export function questionModel(options: FakeQuestionModelOptions = {}): FakeTurn {
    return { kind: 'repeat', turn: { kind: 'respond', answer: (body) => questionModelAnswer(body, options) } };
}
