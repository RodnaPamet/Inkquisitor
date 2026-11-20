/**
 * A dial's sentence is prompt text (Phase 2.H item 7): every question and
 * rephrase call adds `roundGuidance` to its template's system prompt, so a
 * change to that code must change the prompts' content hashes — or the
 * records go on vouching for words the product no longer sends, and
 * `tests/guards/evaluation-records-current.test.ts` cannot see it.
 */
type Hashes = { question: string; rephrase: string };

function hashesWith(mutateDials: ((dials: Record<string, unknown>) => Record<string, unknown>) | null): Hashes {
    let out!: Hashes;
    jest.isolateModules(() => {
        if (mutateDials) {
            jest.doMock('@/lib/interview/dials', () => mutateDials(jest.requireActual('@/lib/interview/dials')));
        }
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { questionPromptHash } = require('@/lib/interview/pack-evaluation') as typeof import('@/lib/interview/pack-evaluation');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { rephrasePromptHash } = require('@/lib/interview/evals/rephrase-evaluation') as typeof import('@/lib/interview/evals/rephrase-evaluation');
        out = { question: questionPromptHash(), rephrase: rephrasePromptHash() };
    });
    jest.dontMock('@/lib/interview/dials');
    return out;
}

it('a dial sentence edited (the template untouched) changes the question and rephrase prompt hashes', () => {
    const real = hashesWith(null);
    const edited = hashesWith((dials) => {
        const DEPTH = dials.DEPTH as Record<number, { emphasis: string }>;
        return { ...dials, DEPTH: { ...DEPTH, 3: { ...DEPTH[3], emphasis: `${DEPTH[3].emphasis} Also ask about the weather.` } } };
    });
    expect(edited.question).not.toBe(real.question);
    expect(edited.rephrase).not.toBe(real.rephrase);
});

it('the hashes are stable when nothing changes', () => {
    expect(hashesWith(null)).toEqual(hashesWith(null));
});
