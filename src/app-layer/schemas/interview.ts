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
import { INTERVIEW_SCOPES, PERSONA_KEYS } from '@/lib/interview/vocabulary';
import { PERSONAS_PER_SESSION_MAX } from '@/lib/interview/dial-settings';

const id = z.string().min(1).max(64);
const dial = z.number().int().min(DIAL_MIN).max(DIAL_MAX);

/** At most three known personas, none twice, in the author's order (the first leads round 1). */
const personaList = z
    .array(z.enum(PERSONA_KEYS))
    .max(PERSONAS_PER_SESSION_MAX)
    .refine((list) => new Set(list).size === list.length, { message: 'A persona is named at most once.' });

/**
 * The dials, each optional: a key left out (or null) passes the dial on to
 * the layer below (session → book → workspace → code default). `personaKeys:
 * []` is a setting — no persona — not an absence.
 */
const dialFields = {
    depth: dial.nullish(),
    detail: dial.nullish(),
    personaKeys: personaList.nullish(),
    offerRecommended: z.boolean().nullish(),
    preferChoice: z.boolean().nullish(),
};

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
        /** The session's own dials (Phase 2.3: up to three personas); unset ones come from the book's and workspace's defaults. */
        ...dialFields,
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
export const InterviewDefaultsInput = z.object(dialFields).strict();
export type InterviewDefaultsInput = z.infer<typeof InterviewDefaultsInput>;

export const CloseRoundInput = z.object({ skipUnanswered: z.boolean().optional() }).strict();
export type CloseRoundInput = z.infer<typeof CloseRoundInput>;

/** A round number in a path, bounded to PostgreSQL's integer. */
export const RoundNumberParam = z.coerce.number().int().min(1).max(2_147_483_647);
