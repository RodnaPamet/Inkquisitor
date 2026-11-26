/**
 * QUESTIONS GROUPED BY WHO ASKED (Phase 4.3, D29: persona panels). Pure and
 * client-safe. A round worded by more than one persona is shown one group per
 * persona, in the order each first asked, a question keeping its place within
 * its group; a round with one persona (or none) is one group, shown with no
 * heading. The session and the review pages read this, so both group alike.
 */
export interface PersonaGroup<T> {
    /** The persona that asked (null: a pack fallback, or a session with none), or the caller's own group key (`keyOf`). */
    readonly personaKey: string | null;
    readonly items: readonly T[];
}

export function groupByPersona<T extends { readonly personaKey: string | null }>(items: readonly T[], keyOf: (item: T) => string | null = (item) => item.personaKey): Array<PersonaGroup<T>> {
    const order: Array<string | null> = [];
    const byKey = new Map<string | null, T[]>();
    for (const item of items) {
        const key = keyOf(item);
        const list = byKey.get(key);
        if (list) list.push(item);
        else {
            order.push(key);
            byKey.set(key, [item]);
        }
    }
    if (order.length <= 1) return [{ personaKey: order[0] ?? null, items: [...items] }];
    return order.map((personaKey) => ({ personaKey, items: byKey.get(personaKey)! }));
}

/**
 * Phase 4.4 (D30): the group of the questions code worded (follow-ups, relationships, sources, continuity), which no
 * persona asked. A persona key never holds a colon, so this cannot name one.
 */
export const CODE_WORDED_GROUP = 'product:code-worded';

/** Whether a grouping needs headings: more than one group. */
export function groupsNeedHeadings<T>(groups: ReadonlyArray<PersonaGroup<T>>): boolean {
    return groups.length > 1;
}
