/**
 * What a story map's nodes and edges SHOW, built from the bible's rows
 * (Phase 3.1): an element's name, its kind's label and its completeness
 * badge; a relation's label. Resolved by the host, which has a translator, and
 * handed to the canvas beside the rows (`MapDisplay`); never persisted.
 *
 * The badge follows the bible's completeness rule (rule 6): a template with no
 * fields is "not assessed", never 100 %; only a measured value is a percent,
 * and 100 % only when every field is filled (`completenessPercent`).
 *
 * Client-safe.
 */
import type { MapDisplay, NodeDisplay } from '@/components/canvas/tldraw/serializer';
import { completeness, completenessPercent } from '@/lib/bible/completeness';
import type { BibleKind } from '@/lib/bible/kinds';

export interface DisplayElement {
    name: string;
    kind: BibleKind;
    customLabel: string | null;
    filledFieldCount: number;
    fieldCount: number;
}

export interface BadgeWords {
    notAssessed: string;
    percent: (percent: number) => string;
}

export function nodeDisplayFor(element: DisplayElement, kindLabels: Readonly<Record<string, string>>, words: BadgeWords): NodeDisplay {
    const c = completeness({ entries: 1, filled: element.filledFieldCount, fieldsPerEntry: element.fieldCount });
    const kindLabel = element.customLabel ?? kindLabels[element.kind] ?? element.kind;
    if (c.state !== 'measured') return { name: element.name, kindLabel, badgeLabel: words.notAssessed, badgeTone: 'none' };
    const percent = completenessPercent(c);
    return { name: element.name, kindLabel, badgeLabel: words.percent(percent), badgeTone: percent === 100 ? 'complete' : percent === 0 ? 'none' : 'partial' };
}

export function buildMapDisplay(
    nodes: ReadonlyArray<{ elementId: string; element: DisplayElement }>,
    relations: ReadonlyArray<{ relationId: string; label: string }>,
    kindLabels: Readonly<Record<string, string>>,
    words: BadgeWords,
): MapDisplay {
    return {
        nodes: new Map(nodes.map((n) => [n.elementId, nodeDisplayFor(n.element, kindLabels, words)])),
        edgeLabels: new Map(relations.map((r) => [r.relationId, r.label])),
    };
}
