/**
 * Request shapes for the interview API (Phase 2.2). Every object is
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

const id = z.string().min(1).max(64);
const dial = z.number().int().min(DIAL_MIN).max(DIAL_MAX);

/** The longest written answer any detail accepts, before sanitising (raw bound). */
export const ANSWER_TEXT_RAW_MAX = Math.max(...Object.values(DETAIL).map((d) => d.answerMax)) * RAW_INPUT_FACTOR;

export const InterviewStartInput = z
    .object({
        scope: z.enum(INTERVIEW_SCOPES),
        elementId: id.optional(),
        kind: z.enum(BIBLE_KINDS).optional(),
        depth: dial.optional(),
        detail: dial.optional(),
        /** One persona, or none (Phase 2.2; 2.3 mounts up to three). */
        persona: z.enum(PERSONA_KEYS).nullish(),
        offerRecommended: z.boolean().optional(),
        preferChoice: z.boolean().optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
        if ((v.scope === 'ELEMENT') !== (v.elementId !== undefined)) ctx.addIssue({ code: 'custom', message: 'An element interview names its element, and only it does.', path: ['elementId'] });
        if ((v.scope === 'KIND') !== (v.kind !== undefined)) ctx.addIssue({ code: 'custom', message: 'A kind interview names its kind, and only it does.', path: ['kind'] });
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

export const CloseRoundInput = z.object({ skipUnanswered: z.boolean().optional() }).strict();
export type CloseRoundInput = z.infer<typeof CloseRoundInput>;

/** A round number in a path, bounded to PostgreSQL's integer. */
export const RoundNumberParam = z.coerce.number().int().min(1).max(2_147_483_647);
