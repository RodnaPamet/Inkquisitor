/**
 * Request shapes for the interview API (Phase 2.2; dials and defaults 2.3). Every object is
 * `.strict()`, so an unknown key is a 400 rather than silently dropped. These
 * bound the RAW input; the usecases sanitise every text value and check it
 * again against the question it answers and the session's detail dial.
 */
import { z } from 'zod';
import { BIBLE_KINDS } from '@/lib/bible/kinds';
import { RAW_INPUT_FACTOR } from '@/lib/bible/field-values';
import { DETAIL, DIAL_MAX, DIAL_MIN } from '@/lib/interview/dials';
import { OPTION_MAX } from '@/lib/interview/candidates';
import { INTERVIEW_SCOPES, PANEL_PERSONA_KEYS, PERSONA_KEYS, QUESTION_GENERATORS, isPanelPersona } from '@/lib/interview/vocabulary';
import { PERSONAS_PER_SESSION_MAX } from '@/lib/interview/dial-settings';
import { SESSION_QUESTIONS_CHOSEN_MAX, SESSION_ROUNDS_MAX } from '@/lib/interview/session-length';

const id = z.string().min(1).max(64);
const dial = z.number().int().min(DIAL_MIN).max(DIAL_MAX);

/** At most three known personas, none twice, in the author's order (the first leads round 1). */
const personaList = z
    .array(z.enum(PERSONA_KEYS))
    .max(PERSONAS_PER_SESSION_MAX)
    .refine((list) => new Set(list).size === list.length, { message: 'A persona is named at most once.' });

/**
 * Phase 4.3 (D29): the book-level panel's personas are the PANEL, never one voice among others. A session's list
 * holds all three of them and nothing else, or none of them: mixed with the six of 2.3 (or cut short) it would not
 * be the panel the setup sheet's preset offers, and a panel voice beside its namesake (Target Reader and Panel: Target
 * Reader) would put two groups in the session asking from the same side of the page.
 */
const sessionPersonaList = personaList.refine(
    (list) => !list.some(isPanelPersona) || (list.length === PANEL_PERSONA_KEYS.length && PANEL_PERSONA_KEYS.every((k) => list.includes(k))),
    { message: 'The panel’s personas question a book together, all three and no other.' },
);

/** Defaults never carry the panel (D29): it is offered only through the setup sheet's preset. */
const defaultsPersonaList = personaList.refine((list) => !list.some(isPanelPersona), { message: 'The panel’s personas are never a default.' });

/**
 * The dials, each optional: a key left out (or null) passes the dial on to
 * the layer below (session → book → workspace → code default). `personaKeys:
 * []` is a setting — no persona — not an absence.
 */
/**
 * Phase 4.4 (D30): the question generators switched off — known, none twice, and never all five (a session with no
 * generator has nothing it could ask).
 */
const generatorList = z
    .array(z.enum(QUESTION_GENERATORS))
    .max(QUESTION_GENERATORS.length - 1)
    .refine((list) => new Set(list).size === list.length, { message: 'A generator is named at most once.' });

const dialFields = {
    depth: dial.nullish(),
    detail: dial.nullish(),
    personaKeys: sessionPersonaList.nullish(),
    offerRecommended: z.boolean().nullish(),
    preferChoice: z.boolean().nullish(),
    generatorsOff: generatorList.nullish(),
};

/** Phase 4.4 (D23): how long the session runs, the author's choice: rounds, questions, or until they stop. */
export const SessionLengthInput = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('ROUNDS'), rounds: z.number().int().min(1).max(SESSION_ROUNDS_MAX) }).strict(),
    z.object({ mode: z.literal('QUESTIONS'), questions: z.number().int().min(1).max(SESSION_QUESTIONS_CHOSEN_MAX) }).strict(),
    z.object({ mode: z.literal('UNTIL_STOPPED') }).strict(),
]);

/** The longest written answer any detail accepts, before sanitising (raw bound). */
export const ANSWER_TEXT_RAW_MAX = Math.max(...Object.values(DETAIL).map((d) => d.answerMax)) * RAW_INPUT_FACTOR;

/** A selection names at most this many elements and this many relations (Phase 3.3; the CHECK holds the same). */
export const SELECTION_ELEMENTS_MAX = 60;
export const SELECTION_RELATIONS_MAX = 60;

export const InterviewStartInput = z
    .object({
        scope: z.enum(INTERVIEW_SCOPES),
        elementId: id.optional(),
        kind: z.enum(BIBLE_KINDS).optional(),
        /** Phase 3.3, SELECTION: the elements and relations selected on a map (either may be empty, not both). */
        elementIds: z.array(id).max(SELECTION_ELEMENTS_MAX).optional(),
        relationIds: z.array(id).max(SELECTION_RELATIONS_MAX).optional(),
        /** Phase 3.3, BETWEEN: the two neighbouring elements the new one would sit between, in story order. */
        afterElementId: id.optional(),
        beforeElementId: id.optional(),
        /** Phase 4.2 (D28), SELECTION of one element: "Grill me on what changed", the stale flag it answers. */
        staleFlagId: id.optional(),
        /** Phase 4.3 (D29), SELECTION: the stress test whose weak points the session asks about (its elements, as the test's view names them). */
        stressTestId: id.optional(),
        /** The session's own dials (Phase 2.3: up to three personas); unset ones come from the book's and workspace's defaults. */
        ...dialFields,
        /** Phase 4.4 (D23): the session's length; omitted, `DEFAULT_SESSION_LENGTH`. */
        length: SessionLengthInput.optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
        if ((v.scope === 'ELEMENT') !== (v.elementId !== undefined)) ctx.addIssue({ code: 'custom', message: 'An element interview names its element, and only it does.', path: ['elementId'] });
        if ((v.scope === 'KIND') !== (v.kind !== undefined)) ctx.addIssue({ code: 'custom', message: 'A kind interview names its kind, and only it does.', path: ['kind'] });
        const selecting = v.elementIds !== undefined || v.relationIds !== undefined;
        if ((v.scope === 'SELECTION') !== selecting) ctx.addIssue({ code: 'custom', message: 'A selection names its elements and relations, and only it does.', path: ['elementIds'] });
        if (v.staleFlagId !== undefined && (v.scope !== 'SELECTION' || v.elementIds?.length !== 1 || (v.relationIds?.length ?? 0) > 0)) {
            ctx.addIssue({ code: 'custom', message: 'A grill on what changed is a selection of its one element.', path: ['staleFlagId'] });
        }
        if (v.stressTestId !== undefined && (v.scope !== 'SELECTION' || v.staleFlagId !== undefined || (v.relationIds?.length ?? 0) > 0 || (v.elementIds?.length ?? 0) === 0)) {
            ctx.addIssue({ code: 'custom', message: 'A session from a stress test is a selection of its elements, and nothing else.', path: ['stressTestId'] });
        }
        const slot = v.afterElementId !== undefined || v.beforeElementId !== undefined;
        if (v.scope === 'BETWEEN' ? v.afterElementId === undefined || v.beforeElementId === undefined : slot) {
            ctx.addIssue({ code: 'custom', message: 'A between interview names both neighbours, and only it does.', path: ['afterElementId'] });
        }
    });
export type InterviewStartInput = z.infer<typeof InterviewStartInput>;

/** An answer: the reply its question's kind takes, or the recommended one taken as offered. */
export const AnswerInput = z
    .object({
        text: z.string().max(ANSWER_TEXT_RAW_MAX).optional(),
        choice: z.string().max(OPTION_MAX * RAW_INPUT_FACTOR).optional(),
        scale: z.number().int().min(1).max(5).optional(),
        acceptRecommendation: z.literal(true).optional(),
    })
    .strict();
export type AnswerInput = z.infer<typeof AnswerInput>;

/**
 * A layer of interview defaults (workspace or book), replaced whole: each dial
 * a value, or left out / null to pass it on to the layer below.
 */
export const InterviewDefaultsInput = z.object({ ...dialFields, personaKeys: defaultsPersonaList.nullish() }).strict();
export type InterviewDefaultsInput = z.infer<typeof InterviewDefaultsInput>;

export const CloseRoundInput = z.object({ skipUnanswered: z.boolean().optional() }).strict();

/** Phase 4.4 (D30): the next round's body — `goOn: true` is the author's choice to go on past the minor questions (VALUE_FELL). */
export const NextRoundInput = z.object({ goOn: z.literal(true).optional() }).strict();
export type NextRoundInput = z.infer<typeof NextRoundInput>;
export type CloseRoundInput = z.infer<typeof CloseRoundInput>;

/** A round number in a path, bounded to PostgreSQL's integer. */
export const RoundNumberParam = z.coerce.number().int().min(1).max(2_147_483_647);
