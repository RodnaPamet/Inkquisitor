/**
 * A deterministic question generator for tests (Phase 2.2; since 2.3 the
 * product's STRUCTURAL generator, `src/lib/interview/evals/structural-generator.ts`,
 * plus the knobs below): no model, no network, no 2.1 call. It reads what the engine's request allows — the
 * `targets.N` data blocks and the detail dial's kinds in the template's system
 * text — and words one
 * well-formed question per allowed target, so a test sees exactly what the
 * engine does with a generator that behaves. `mutate` bends its output to
 * test what the engine does with one that does not.
 */
import type { GenerationFailureKind, GenerationRequest, GenerationResult, QuestionGenerator } from '@/lib/interview/generator';
import type { GeneratedQuestion } from '@/lib/interview/candidates';
import { allowedTargets, kindsInPrompt, structuralQuestion } from '@/lib/interview/evals/structural-generator';

export interface FakeGeneratorOptions {
    /** Rewrite (or drop, with an empty array) each question the fake would send. */
    mutate?: (q: GeneratedQuestion, request: GenerationRequest) => GeneratedQuestion | GeneratedQuestion[];
    /** Raw output in place of the fake's own (anything: the engine re-parses it). */
    raw?: (request: GenerationRequest) => unknown;
    /** Every call throws (a provider failure). */
    fail?: boolean;
    /** Every call fails with this 2.1 outcome, named (`failure`), spending `tokensPerCall`. */
    failWith?: GenerationFailureKind;
    /** The tokens each call reports (default 0). */
    tokensPerCall?: number;
}

export interface FakeGenerator extends QuestionGenerator {
    readonly calls: GenerationRequest[];
}

/** The structural generator's helpers (`src/lib/interview/evals/structural-generator.ts`), named as the tests know them. */
export { allowedTargets, dataBlocks, kindsInPrompt, structuralQuestion as fakeQuestion } from '@/lib/interview/evals/structural-generator';

export function fakeGenerator(options: FakeGeneratorOptions = {}): FakeGenerator {
    const calls: GenerationRequest[] = [];
    return {
        unavailableReason: () => null,
        calls,
        async generateCandidates(request): Promise<GenerationResult> {
            calls.push(request);
            if (options.fail) throw new Error('provider unavailable');
            const tokensUsed = options.tokensPerCall ?? 0;
            if (options.failWith) return { output: null, tokensUsed, failure: { kind: options.failWith, errorCode: 'FAKE' } };
            if (options.raw) return { output: options.raw(request), tokensUsed };
            const kinds = kindsInPrompt(request);
            const questions = allowedTargets(request).flatMap((t) =>
                t.allowed_targets.flatMap((key) => {
                    const q = structuralQuestion(t.elementId, key, kinds);
                    const out = options.mutate ? options.mutate(q, request) : q;
                    return Array.isArray(out) ? out : [out];
                }),
            );
            return { output: { questions, declined: [] }, tokensUsed };
        },
    };
}
