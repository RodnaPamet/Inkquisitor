/**
 * THE ONE RULE A TIE-BREAK IS HELD TO (Phase 4.4, D30 item 4). Pure. The answer
 * is accepted only as an EXACT PERMUTATION of the numbers the call was shown
 * (1..n, each once); anything else — unreadable, a number missing, one twice, one
 * the call was not shown — is refused by name, and the code's order stands. A
 * permutation cannot add, drop or rescore a candidate, and holds no text, so
 * nothing the model says can reach the author or the bible.
 */
import { QuestionOrderOutputSchema } from './schema';

export const ORDER_REFUSALS = ['INVALID_OUTPUT', 'NOT_A_PERMUTATION'] as const;
export type OrderRefusal = (typeof ORDER_REFUSALS)[number];

export function validateQuestionOrder(raw: unknown, n: number): { ok: true; order: number[] } | { ok: false; reason: OrderRefusal } {
    const parsed = QuestionOrderOutputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'INVALID_OUTPUT' };
    const order = parsed.data.order;
    if (order.length !== n || new Set(order).size !== n || order.some((x) => x < 1 || x > n)) return { ok: false, reason: 'NOT_A_PERMUTATION' };
    return { ok: true, order: [...order] };
}

/** Apply an accepted order to the items it was shown (order[i] is the 1-based number of the item that goes i-th). */
export function applyQuestionOrder<T>(items: readonly T[], order: readonly number[]): T[] {
    return order.map((x) => items[x - 1]);
}
