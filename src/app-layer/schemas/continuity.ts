/**
 * Request shapes for the Continuity API (Phase 4.2, D28). Every object is
 * `.strict()`. They bound the RAW input (at most `RAW_INPUT_FACTOR` times the
 * stored bound); the usecases sanitise every value before anything is stored.
 */
import { z } from 'zod';
import { ALL_THREAD_STATES, THREAD_KINDS, THREAD_NOTE_MAX, THREAD_TITLE_MAX } from '@/lib/continuity/vocabulary';

const RAW = 4;
const id = z.string().min(1).max(64);
const baseVersion = z.number().int().min(1).max(2_147_483_647);

export const ContinuityThreadInput = z
    .object({
        kind: z.enum(THREAD_KINDS),
        title: z.string().min(1).max(THREAD_TITLE_MAX * RAW),
        note: z.string().max(THREAD_NOTE_MAX * RAW).nullable().optional(),
        state: z.enum(ALL_THREAD_STATES).optional(),
        subjectElementId: id.nullable().optional(),
    })
    .strict();

export const ContinuityThreadUpdateInput = z
    .object({
        baseVersion,
        title: z.string().min(1).max(THREAD_TITLE_MAX * RAW).optional(),
        note: z.string().max(THREAD_NOTE_MAX * RAW).nullable().optional(),
        state: z.enum(ALL_THREAD_STATES).optional(),
        subjectElementId: id.nullable().optional(),
    })
    .strict();

export const ThreadProposalDecisionInput = z.object({ decision: z.enum(['ACCEPT', 'REJECT']) }).strict();
