/**
 * Request shapes for the draft held against the bible and the scene card (Phase 5.3, D35). Every object is `.strict()`
 * and bounds the RAW input (at most `RAW_INPUT_FACTOR` times the stored bound); the usecases sanitise every value
 * before anything is stored.
 */
import { z } from 'zod';
import { DRAFT_EXPLANATION_MAX, LINK_DECISIONS } from '@/lib/draft-facts/vocabulary';
import { SCENE_CARD_FIELD_MAX } from '@/lib/manuscript/scene-card';

const RAW = 4;

/** FIX_DRAFT and BOTH_TRUE: UPDATE_BIBLE is the author's own save (`DraftUpdateBibleInput`), never a decision alone. */
export const DraftMismatchDecisionInput = z
    .object({
        decision: z.enum(['FIX_DRAFT', 'BOTH_TRUE']),
        explanation: z.string().max(DRAFT_EXPLANATION_MAX * RAW).optional(),
    })
    .strict();

/** "Update the bible": the author's edited value of the field (normalised and sanitised by the field's own rules), against the element's version. */
export const DraftUpdateBibleInput = z
    .object({
        baseVersion: z.number().int().min(1).max(2_147_483_647),
        value: z.unknown(),
    })
    .strict();

export const ThreadSceneLinkDecisionInput = z.object({ decision: z.enum(LINK_DECISIONS) }).strict();

const cardField = z.string().max(SCENE_CARD_FIELD_MAX * RAW).nullable();

/** A scene card's whole state, against its version (0: no card yet). */
export const SceneCardInput = z
    .object({
        baseVersion: z.number().int().min(0).max(2_147_483_647),
        goal: cardField,
        conflict: cardField,
        outcome: cardField,
        change: cardField,
    })
    .strict();
