/**
 * Request shapes for the prose-check API (Phase 5.2, D34). Every object is
 * `.strict()` and bounded; a rule id must be one of the rules.
 */
import { z } from 'zod';
import { PROSE_RULE_IDS, TOGGLEABLE_RULE_IDS } from '@/lib/prose-checks/vocabulary';

const id = z.string().min(1).max(64);

export const ProseFindingIdParam = id;

/** Dismiss one note (it stays dismissed while its sentence is unchanged). */
export const DismissProseFindingInput = z.object({ findingId: id }).strict();

/** The book's settings, replaced whole: the inclusive-language switch and the rules turned off. */
export const ProseCheckSettingsInput = z
    .object({
        alexEnabled: z.boolean(),
        rulesOff: z
            .array(z.enum(PROSE_RULE_IDS))
            .max(PROSE_RULE_IDS.length)
            .refine((ids) => ids.every((r) => TOGGLEABLE_RULE_IDS.includes(r)), { message: 'the inclusive-language check has its own switch' }),
    })
    .strict();
