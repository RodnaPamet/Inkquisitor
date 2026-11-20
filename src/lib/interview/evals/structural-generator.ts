/**
 * THE STRUCTURAL GENERATOR (Phase 2.3): a deterministic question generator
 * with no model behind it — no network, no 2.1 call. It reads only what the
 * engine's request allows (the `targets.N` data blocks and the detail dial's
 * kinds in the template's system text) and words one well-formed question per
 * allowed target from the field key alone.
 *
 * Two users:
 *
 *   * tests (through `tests/helpers/fake-question-generator.ts`, which adds
 *     the knobs that bend it), so a test sees exactly what the engine does
 *     with a generator that behaves;
 *   * `npm run packs:evaluate`, which runs every pack's evaluation set through
 *     it and writes a STRUCTURAL evaluation record (`pack-evaluation.ts`): a
 *     record that proves the pack loads, its set runs end to end through the
 *     product's round engine and every code-graded expectation holds — and
 *     proves nothing about how a model words questions under the pack. So the
 *     mount gate accepts a structural record in development and test only:
 *     production mounts a pack only on a real model's record (decision D11,
 *     `pack-records-config.ts`).
 *
 * It ignores the pack text entirely, which is the point: a structural record
 * is a statement about the engine and the set, never about the pack's prose.
 */
import type { GeneratedQuestion } from '../candidates';
import type { GenerationRequest, GenerationResult, QuestionGenerator } from '../generator';
import type { QuestionKind } from '../vocabulary';

/** Names this generator in an evaluation record. A change to what it words is a new id. */
export const STRUCTURAL_GENERATOR_ID = 'structural-generator.1';

export interface AllowedTargets {
    elementId: string;
    allowed_targets: string[];
    may_challenge: string | null;
}

/** A request's data blocks (the author text 2.1 will fence), by label. */
export function dataBlocks(request: GenerationRequest): Map<string, string> {
    return new Map(request.data.map((b) => [b.label, b.text]));
}

/** The `targets.N` blocks of a request. */
export function allowedTargets(request: GenerationRequest): AllowedTargets[] {
    return [...dataBlocks(request)].filter(([label]) => label.startsWith('targets.')).map(([, body]) => JSON.parse(body) as AllowedTargets);
}

/** The question kinds the request's system text allows (the detail dial's). */
export function kindsInPrompt(request: GenerationRequest): QuestionKind[] {
    const m = /Use only these question kinds: ([A-Z_, ]+)\./.exec(request.template.system);
    return m ? (m[1].split(', ') as QuestionKind[]) : [];
}

/** The structural question for one field: OPEN where allowed, else CHOICE, else SCALE. */
export function structuralQuestion(elementId: string, fieldKey: string, kinds: readonly QuestionKind[]): GeneratedQuestion {
    const words = fieldKey.split('_').join(' ');
    const base = { elementId, targetsFieldKeys: [fieldKey], mode: 'FRONTIER' as const, rationale: `Asks for the ${words}.` };
    if (kinds.includes('OPEN')) return { ...base, kind: 'OPEN', text: `What ${words} matters most here, in your own words?` };
    if (kinds.includes('CHOICE')) return { ...base, kind: 'CHOICE', text: `Which way does the ${words} lean?`, options: [`${words} leans inward`, `${words} leans outward`, `${words} holds still`] };
    return { ...base, kind: 'SCALE', text: `How strong is the ${words}?`, scaleLabels: { low: 'faint', high: 'overwhelming' } };
}

/** The structural output for one request: a question per allowed target, nothing declined. */
export function structuralOutput(request: GenerationRequest): { questions: GeneratedQuestion[]; declined: [] } {
    const kinds = kindsInPrompt(request);
    return { questions: allowedTargets(request).flatMap((t) => t.allowed_targets.map((key) => structuralQuestion(t.elementId, key, kinds))), declined: [] };
}

/** The structural generator: always available, never fails, reports no tokens. */
export function structuralGenerator(): QuestionGenerator {
    return {
        unavailableReason: () => null,
        async generateCandidates(request: GenerationRequest): Promise<GenerationResult> {
            return { output: structuralOutput(request), tokensUsed: 0 };
        },
    };
}
