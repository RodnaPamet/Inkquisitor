/**
 * The tie-break's structured output (Phase 4.4, D30 item 4): an order of the candidate numbers it was shown. CODE,
 * never built from author text (D5), within 2.1's limits.
 */
import { z } from 'zod';
import { QUESTION_ORDER_GROUP_MAX } from './prompt';

export const QuestionOrderOutputSchema = z.object({ order: z.array(z.number().int().min(1).max(QUESTION_ORDER_GROUP_MAX)).max(QUESTION_ORDER_GROUP_MAX * 2) }).strict();
