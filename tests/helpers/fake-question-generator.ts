/**
 * A deterministic question generator for tests (Phase 2.2): no model, no
 * network. It reads what the engine's prompt allows — the `allowed_targets`
 * data blocks and the detail dial's kinds in the system text — and words one
 * well-formed question per allowed target, so a test sees exactly what the
 * engine does with a generator that behaves. `mutate` bends its output to
 * test what the engine does with one that does not.
 */
import type { GenerationRequest, QuestionGenerator } from '@/lib/interview/generator';
import type { GeneratedQuestion } from '@/lib/interview/candidates';
import type { QuestionKind } from '@/lib/interview/vocabulary';

export interface FakeGeneratorOptions {
    /** Rewrite (or drop, with an empty array) each question the fake would send. */
    mutate?: (q: GeneratedQuestion, request: GenerationRequest) => GeneratedQuestion | GeneratedQuestion[];
    /** Raw output in place of the fake's own (anything: the engine re-parses it). */
    raw?: (request: GenerationRequest) => unknown;
    /** Every call throws (a provider failure). */
    fail?: boolean;
}

export interface FakeGenerator extends QuestionGenerator {
    readonly calls: GenerationRequest[];
}

interface AllowedTargets {
    elementId: string;
    allowed_targets: string[];
    may_challenge: string | null;
}

/** The fenced data blocks of a request, by name, decoded. */
export function dataBlocks(user: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of user.matchAll(/<data name="([^"]+)">\n(.*)\n<\/data>/g)) out.set(m[1], JSON.parse(m[2]) as string);
    return out;
}

export function allowedTargets(request: GenerationRequest): AllowedTargets[] {
    return [...dataBlocks(request.user)].filter(([name]) => name.startsWith('allowed_targets_')).map(([, body]) => JSON.parse(body) as AllowedTargets);
}

export function kindsInPrompt(request: GenerationRequest): QuestionKind[] {
    const m = /Use only these question kinds: ([A-Z_, ]+)\./.exec(request.system);
    return m ? (m[1].split(', ') as QuestionKind[]) : [];
}

/** The fake's question for one field. */
export function fakeQuestion(elementId: string, fieldKey: string, kinds: readonly QuestionKind[]): GeneratedQuestion {
    const words = fieldKey.split('_').join(' ');
    const base = { elementId, targetsFieldKeys: [fieldKey], mode: 'FRONTIER' as const, rationale: `Asks for the ${words}.` };
    if (kinds.includes('OPEN')) return { ...base, kind: 'OPEN', text: `What ${words} matters most here, in your own words?` };
    if (kinds.includes('CHOICE')) return { ...base, kind: 'CHOICE', text: `Which way does the ${words} lean?`, options: [`${words} leans inward`, `${words} leans outward`, `${words} holds still`] };
    return { ...base, kind: 'SCALE', text: `How strong is the ${words}?`, scaleLabels: { low: 'faint', high: 'overwhelming' } };
}

export function fakeGenerator(options: FakeGeneratorOptions = {}): FakeGenerator {
    const calls: GenerationRequest[] = [];
    return {
        wired: true,
        calls,
        async generateCandidates(request) {
            calls.push(request);
            if (options.fail) throw new Error('provider unavailable');
            if (options.raw) return options.raw(request);
            const kinds = kindsInPrompt(request);
            const questions = allowedTargets(request).flatMap((t) =>
                t.allowed_targets.flatMap((key) => {
                    const q = fakeQuestion(t.elementId, key, kinds);
                    const out = options.mutate ? options.mutate(q, request) : q;
                    return Array.isArray(out) ? out : [out];
                }),
            );
            return { questions, declined: [] };
        },
    };
}
