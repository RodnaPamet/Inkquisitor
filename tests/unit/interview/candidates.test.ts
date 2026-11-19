/**
 * Candidate validation (design 4.3): one fixture per rule, each a candidate
 * that breaks exactly that rule and is dropped, with the repaired candidate
 * passing; a failing recommendation is stripped and the question kept; the
 * model's raw output is read item by item.
 */
import {
    candidateFrom,
    isCatchAllOption,
    isVerbatimQuote,
    parseGeneratedQuestions,
    validateCandidate,
    type Candidate,
    type ValidationContext,
} from '@/lib/interview/candidates';
import { refKey } from '@/lib/interview/frontier';

const EL = 'el-1';
const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
    detail: 3,
    offerRecommended: true,
    elements: new Map([
        [
            EL,
            {
                elementId: EL,
                fieldKeys: new Set(['role', 'want', 'wound', 'need']),
                storedText: new Map([['role', 'A night-shift paramedic in a small coastal town']]),
            },
        ],
    ]),
    assignments: new Map([
        [refKey({ elementId: EL, fieldKey: 'want' }), 'socratic'],
        [refKey({ elementId: EL, fieldKey: 'wound' }), 'socratic'],
    ]),
    challenge: { elementId: EL, fieldKey: 'role', personaKey: 'socratic' },
    answerText: new Map([['a1', 'He wants to be made crew chief before his colleague']]),
    ...over,
});

const good: Candidate = {
    elementId: EL,
    targetsFieldKeys: ['want'],
    mode: 'FRONTIER',
    kind: 'OPEN',
    text: 'What does your protagonist go after, in their own words?',
    options: null,
    scaleLabels: null,
    challengeQuote: null,
    recommendedAnswer: null,
    recommendationBasis: null,
    rationale: 'The want is open.',
    personaKey: 'socratic',
};

const choice: Candidate = { ...good, kind: 'CHOICE', text: 'Which way does the want point?', options: ['towards rank', 'towards safety', 'towards being seen'] };

it('the repaired candidate passes (every case below fails for its own defect)', () => {
    expect(validateCandidate(good, ctx())).toEqual({ ok: true, candidate: good, stripped: null });
    expect(validateCandidate(choice, ctx())).toMatchObject({ ok: true });
});

describe('targets', () => {
    it.each([
        ['another element', { elementId: 'el-2' }, 'UNKNOWN_ELEMENT'],
        ['a key the template lacks', { targetsFieldKeys: ['eye_colour'] }, 'UNKNOWN_FIELD'],
        ['no key at all', { targetsFieldKeys: [] }, 'UNKNOWN_FIELD'],
        ['a stored field asked afresh', { targetsFieldKeys: ['role'] }, 'NOT_ASSIGNED'],
        ['a field not on this round', { targetsFieldKeys: ['need'] }, 'NOT_ASSIGNED'],
        ['another persona’s field', { personaKey: 'gentle-mentor' }, 'NOT_ASSIGNED'],
        ['one key twice', { targetsFieldKeys: ['want', 'want'] }, 'REPEATED_TARGET'],
    ] as const)('%s is dropped', (_l, over, reason) => {
        expect(validateCandidate({ ...good, ...over } as Candidate, ctx())).toEqual({ ok: false, reason });
    });

    it('two fields only from detail 3', () => {
        const pair = { ...good, targetsFieldKeys: ['want', 'wound'] };
        expect(validateCandidate(pair, ctx())).toMatchObject({ ok: true });
        expect(validateCandidate({ ...pair, kind: 'CHOICE', options: choice.options }, ctx({ detail: 2 }))).toEqual({ ok: false, reason: 'TOO_MANY_TARGETS' });
    });
});

describe('kinds, options and text', () => {
    it.each([
        ['an OPEN question at detail 1', { detail: 1 }, good, 'KIND_NOT_ALLOWED'],
        ['a CHOICE at detail 5', { detail: 5 }, choice, 'KIND_NOT_ALLOWED'],
    ] as const)('%s is dropped', (_l, over, c, reason) => {
        expect(validateCandidate(c, ctx(over))).toEqual({ ok: false, reason });
    });

    it.each([
        ['a CHOICE with two options', { options: ['a', 'b'] }],
        ['a CHOICE with six options', { options: ['a', 'b', 'c', 'd', 'e', 'f'] }],
        ['a catch-all option', { options: ['towards rank', 'towards safety', 'Other'] }],
        ['a repeated option', { options: ['towards rank', 'Towards rank', 'towards safety'] }],
        ['scale labels on a CHOICE', { scaleLabels: { low: 'a', high: 'b' } }],
    ])('%s is MALFORMED_OPTIONS', (_l, over) => {
        expect(validateCandidate({ ...choice, ...over }, ctx())).toEqual({ ok: false, reason: 'MALFORMED_OPTIONS' });
    });

    it('EITHER_OR takes exactly two, OPEN none, SCALE both anchors', () => {
        expect(validateCandidate({ ...choice, kind: 'EITHER_OR', options: ['a', 'b'] }, ctx())).toMatchObject({ ok: true });
        expect(validateCandidate({ ...choice, kind: 'EITHER_OR' }, ctx())).toEqual({ ok: false, reason: 'MALFORMED_OPTIONS' });
        expect(validateCandidate({ ...good, options: ['a', 'b', 'c'] }, ctx())).toEqual({ ok: false, reason: 'MALFORMED_OPTIONS' });
        expect(validateCandidate({ ...good, kind: 'SCALE', text: 'How hard does it press?' }, ctx())).toEqual({ ok: false, reason: 'MALFORMED_OPTIONS' });
        expect(validateCandidate({ ...good, kind: 'SCALE', text: 'How hard does it press?', scaleLabels: { low: 'barely', high: 'wholly' } }, ctx())).toMatchObject({ ok: true });
    });

    it.each([
        ['no question mark', 'Tell me what your protagonist wants.', 'COMPOUND_QUESTION'],
        ['two questions', 'What do they want? And why?', 'COMPOUND_QUESTION'],
        ['too long', `${'Why '.repeat(80)}?`, 'TEXT_TOO_LONG'],
        ['empty', '   ', 'EMPTY_TEXT'],
    ] as const)('text with %s is dropped', (_l, text, reason) => {
        expect(validateCandidate({ ...good, text }, ctx())).toEqual({ ok: false, reason });
    });

    it('catch-all options are recognised however they are cased', () => {
        expect(['Other', 'none of these', 'All of the above.', 'Something else', 'I don’t know'].map(isCatchAllOption)).toEqual([true, true, true, true, false]);
        expect(isCatchAllOption("I don't know")).toBe(true);
        expect(isCatchAllOption('otherworldly calm')).toBe(false);
    });
});

describe('challenges', () => {
    const challenge: Candidate = {
        ...good,
        mode: 'CHALLENGE',
        targetsFieldKeys: ['role'],
        challengeQuote: 'night-shift paramedic in a small',
        text: 'You call them a night-shift paramedic in a small town: what does the job cost them?',
    };

    it('a challenge quoting four words of the stored value, inside its text, passes', () => {
        expect(validateCandidate(challenge, ctx())).toMatchObject({ ok: true });
    });

    it.each([
        ['a quote the value does not hold', { challengeQuote: 'a paramedic who hates the sea', text: 'You say a paramedic who hates the sea: why?' }],
        ['a quote under four words', { challengeQuote: 'night-shift paramedic', text: 'Why a night-shift paramedic?' }],
        ['a text that does not carry its quote', { text: 'What does the job cost them?' }],
    ])('%s is BAD_CHALLENGE', (_l, over) => {
        expect(validateCandidate({ ...challenge, ...over }, ctx())).toEqual({ ok: false, reason: 'BAD_CHALLENGE' });
    });

    it('a challenge of a field the round did not plan is not assigned; a frontier question carries no quote', () => {
        expect(validateCandidate({ ...challenge, targetsFieldKeys: ['want'] }, ctx())).toEqual({ ok: false, reason: 'NOT_ASSIGNED' });
        expect(validateCandidate(challenge, ctx({ challenge: null }))).toEqual({ ok: false, reason: 'NOT_ASSIGNED' });
        expect(validateCandidate({ ...good, challengeQuote: 'night-shift paramedic in a small' }, ctx())).toEqual({ ok: false, reason: 'BAD_CHALLENGE' });
    });

    it('a quote is compared after normalisation (case, zero-width characters, look-alike letters)', () => {
        expect(isVerbatimQuote('NIGHT-SHIFT​ PARAMEDIC in a', 'A night-shift paramedic in a small town')).toBe(true);
        expect(isVerbatimQuote('night-shift раramedic in a', 'A night-shift paramedic in a small town')).toBe(true); // Cyrillic р, а
    });
});

describe('recommendations: stripped, never fatal', () => {
    it.each([
        ['a CHOICE recommendation that is not an option', { ...choice, recommendedAnswer: 'towards love' }, 'NOT_AN_OPTION'],
        ['a SCALE recommendation outside 1..5', { ...good, kind: 'SCALE', text: 'How hard?', scaleLabels: { low: 'a', high: 'b' }, recommendedAnswer: 'five' }, 'NOT_A_SCALE_VALUE'],
        ['an OPEN recommendation inventing content', { ...good, recommendedAnswer: 'To sail to Lisbon with his brother Tomas.', recommendationBasis: { fieldKeys: ['role'], answerIds: [] } }, 'UNGROUNDED'],
        ['an OPEN recommendation citing nothing', { ...good, recommendedAnswer: 'To be made crew chief.' }, 'UNGROUNDED'],
        ['a basis naming an unknown answer', { ...good, recommendedAnswer: 'To be crew chief.', recommendationBasis: { fieldKeys: [], answerIds: ['a9'] } }, 'BASIS_UNKNOWN'],
    ] as const)('%s', (_l, c, why) => {
        const v = validateCandidate(c as Candidate, ctx());
        expect(v).toMatchObject({ ok: true, stripped: why });
        expect(v.ok && v.candidate.recommendedAnswer).toBe(null);
    });

    it('a grounded recommendation, an option verbatim, or a scale number is kept', () => {
        const grounded = { ...good, recommendedAnswer: 'To be made crew chief before his colleague.', recommendationBasis: { fieldKeys: [], answerIds: ['a1'] } };
        expect(validateCandidate(grounded, ctx())).toMatchObject({ ok: true, stripped: null, candidate: { recommendedAnswer: grounded.recommendedAnswer } });
        expect(validateCandidate({ ...choice, recommendedAnswer: 'towards rank' }, ctx())).toMatchObject({ ok: true, stripped: null });
    });

    it('a basis never outlives its recommendation: none is kept without one (model strings, unchecked, unencrypted)', () => {
        const smuggled = { ...good, recommendationBasis: { fieldKeys: ['role'], answerIds: ['the author said her name is Mara'] } };
        const v = validateCandidate(smuggled, ctx());
        expect(v).toMatchObject({ ok: true, stripped: null });
        expect(v.ok && v.candidate.recommendationBasis).toBeNull();
    });

    it('a recommendation longer than the session accepts as an answer is stripped (accepting it could store more than typing)', () => {
        // Detail 2 takes written answers of at most 300 characters.
        const long = `To be made crew chief before his colleague. ${'He wants to be made crew chief before his colleague. '.repeat(6)}`.trim();
        expect(long.length).toBeGreaterThan(300);
        const c = { ...good, recommendedAnswer: long, recommendationBasis: { fieldKeys: [], answerIds: ['a1'] } };
        expect(validateCandidate(c, ctx({ detail: 2 }))).toMatchObject({ ok: true, stripped: 'TOO_LONG', candidate: { recommendedAnswer: null } });
    });

    it('a rationale beyond its bound is dropped and the question kept', () => {
        const v = validateCandidate({ ...good, rationale: 'x'.repeat(401) }, ctx());
        expect(v).toMatchObject({ ok: true, candidate: { rationale: null } });
        expect(validateCandidate({ ...good, rationale: 'x'.repeat(400) }, ctx())).toMatchObject({ ok: true, candidate: { rationale: 'x'.repeat(400) } });
    });

    it('with the toggle off, every recommendation is stripped', () => {
        expect(validateCandidate({ ...choice, recommendedAnswer: 'towards rank' }, ctx({ offerRecommended: false }))).toMatchObject({ ok: true, stripped: 'TOGGLE_OFF' });
    });
});

describe('reading the raw output', () => {
    const item = { elementId: EL, targetsFieldKeys: ['want'], mode: 'FRONTIER', kind: 'OPEN', text: 'What do they want?', rationale: '' };

    it('keeps the items that parse and counts the rest', () => {
        const parsed = parseGeneratedQuestions({ questions: [item, { ...item, kind: 'ESSAY' }, { ...item, extra: 1 }, 'nonsense'], declined: [{ elementId: EL, fieldKey: 'need', reason: 'NEEDS_ANOTHER_ELEMENT_FIRST' }, { bad: 1 }] });
        expect(parsed.questions).toHaveLength(1);
        expect(parsed.malformed).toBe(3);
        expect(parsed.declined).toHaveLength(1);
        expect(candidateFrom(parsed.questions[0], 'socratic')).toMatchObject({ personaKey: 'socratic', rationale: null, options: null });
    });

    it('an output that is not an object with questions is unreadable, and yields nothing', () => {
        for (const raw of [null, 'text', { questions: 'x' }, []]) expect(parseGeneratedQuestions(raw)).toMatchObject({ unreadable: true, questions: [] });
    });

    it('more items than a call may carry are counted malformed, not read', () => {
        expect(parseGeneratedQuestions({ questions: Array(15).fill(item) })).toMatchObject({ malformed: 3 });
    });
});
