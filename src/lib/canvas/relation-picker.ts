/**
 * The type picker's choices (Phase 3.2): what an arrow drawn from one node to
 * another can become, read from the two kinds' templates.
 *
 * An arrow from A to B offers every relation type A's kind may START towards
 * B's kind (read "A <label> B", stored from A), every type B's kind declares
 * towards A's (read from A's end with its inverse label, "A <inverse> B", but
 * STORED FROM B: a relation is stored once, from the kind that declares it),
 * and the built-in `related_to`. A symmetric type declared by a kind towards
 * itself is offered once: from either end it is the same fact. These are
 * exactly the element page's relation options (`relationOptionsFor`), filtered
 * to B's kind, so the canvas and the page never disagree about what can link
 * two elements.
 *
 * A choice the pair already holds is left out: the same type, the same way
 * round, or for a symmetric type either way round (the server refuses that
 * twice, `RELATION_EXISTS`).
 *
 * Client-safe: it reads `RelationOption`s the page hands over, never the
 * template registry.
 */
import type { RelationOption } from '@/lib/bible/ui-model';

export interface PickerChoice {
    /** Unique among one picker's choices. */
    id: string;
    type: string;
    /** Read from the arrow's start: "A <label> B". */
    label: string;
    /** How the relation is stored. */
    fromElementId: string;
    toElementId: string;
    symmetric: boolean;
}

export interface PickerEnds {
    /** The element the arrow starts at, and its kind. */
    a: { id: string; kind: string };
    /** The element the arrow ends at, and its kind. */
    b: { id: string; kind: string };
}

export function relationPickerChoices(
    ends: PickerEnds,
    optionsForA: readonly RelationOption[],
    existing: ReadonlyArray<{ type: string; sourceElementId: string; targetElementId: string }>,
): PickerChoice[] {
    const held = (type: string, from: string, to: string, symmetric: boolean) =>
        existing.some(
            (r) => r.type === type && ((r.sourceElementId === from && r.targetElementId === to) || (symmetric && r.sourceElementId === to && r.targetElementId === from)),
        );
    const choices: PickerChoice[] = [];
    for (const o of optionsForA) {
        if (!o.otherKinds.includes(ends.b.kind as RelationOption['otherKinds'][number])) continue;
        const fromElementId = o.direction === 'outgoing' ? ends.a.id : ends.b.id;
        const toElementId = o.direction === 'outgoing' ? ends.b.id : ends.a.id;
        if (held(o.type, fromElementId, toElementId, o.symmetric)) continue;
        choices.push({ id: o.id, type: o.type, label: o.label, fromElementId, toElementId, symmetric: o.symmetric });
    }
    return choices;
}
