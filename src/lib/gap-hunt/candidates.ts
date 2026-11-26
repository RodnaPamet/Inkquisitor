/**
 * THE GAP HUNT'S CANDIDATES (Phase 4.3, D29), computed by code before any
 * model is asked. Pure and deterministic over its input.
 *
 * For every (kind, field) of a kind the book holds at least one element of:
 *
 *   empty       the elements of the kind whose field is neither stored nor answered by a live fact (rule 5's reading)
 *   dependents  the template's fields that depend on it, directly or through others (`dependsOn`, transitively)
 *   relations   relations with an element of the kind at one end
 *   facts       live facts about the kind's elements
 *   citations   other elements whose accepted versions cite answers about the kind's elements
 *
 *   weight = 10 + 10·dependents + 5·required + min(10, relations) + min(10, facts) + 2·min(10, citations)
 *   score  = weight · empty / elements          (0 for a field no element leaves empty: never a candidate)
 *
 * Ranked by score, then the kind's order, then the field's order; the top
 * `GAP_CANDIDATES_MAX` are numbered 1, 2, … for the model to cite.
 */
import type { FieldDef } from '@/lib/bible/template-schema';
import { BIBLE_KINDS, type BibleKind } from '@/lib/bible/kinds';
import { fieldLevels } from '@/lib/interview/frontier';
import { GAP_CANDIDATES_MAX, GAP_EMPTY_IDS_KEPT, type GapCandidate } from './vocabulary';

export interface GapElementInput {
    readonly id: string;
    readonly kind: BibleKind;
    /** Keys stored or answered by a live fact. */
    readonly filledKeys: ReadonlySet<string>;
}

export interface GapKindSignals {
    readonly relations: number;
    readonly facts: number;
    readonly citations: number;
}

export interface GapCandidateInput {
    readonly elements: readonly GapElementInput[];
    readonly signals: ReadonlyMap<BibleKind, GapKindSignals>;
    readonly template: (kind: BibleKind) => { readonly label: string; readonly fields: readonly FieldDef[] };
}

/** How many of `fields` depend on `key`, directly or through others. */
export function dependentsOf(fields: readonly Pick<FieldDef, 'key' | 'dependsOn'>[], key: string): number {
    const found = new Set<string>();
    let frontier = [key];
    while (frontier.length > 0) {
        const next: string[] = [];
        for (const f of fields) {
            if (found.has(f.key) || f.key === key) continue;
            if (f.dependsOn.some((d) => frontier.includes(d))) {
                found.add(f.key);
                next.push(f.key);
            }
        }
        frontier = next;
    }
    return found.size;
}

export function gapWeight(c: Pick<GapCandidate, 'dependents' | 'required' | 'relations' | 'facts' | 'citations'>): number {
    return 10 + 10 * c.dependents + (c.required ? 5 : 0) + Math.min(10, c.relations) + Math.min(10, c.facts) + 2 * Math.min(10, c.citations);
}

const NO_SIGNALS: GapKindSignals = { relations: 0, facts: 0, citations: 0 };

/** Every candidate, ranked, the top `max` numbered (the header). */
export function computeGapCandidates(input: GapCandidateInput, max: number = GAP_CANDIDATES_MAX): GapCandidate[] {
    const byKind = new Map<BibleKind, GapElementInput[]>();
    for (const e of input.elements) {
        const list = byKind.get(e.kind);
        if (list) list.push(e);
        else byKind.set(e.kind, [e]);
    }
    const all: Array<Omit<GapCandidate, 'n'> & { kindRank: number; order: number }> = [];
    for (const kind of BIBLE_KINDS) {
        const elements = byKind.get(kind);
        if (!elements || elements.length === 0) continue;
        const template = input.template(kind);
        const levels = fieldLevels(template.fields);
        const signals = input.signals.get(kind) ?? NO_SIGNALS;
        for (const field of template.fields) {
            const emptyOnes = elements.filter((e) => !e.filledKeys.has(field.key));
            if (emptyOnes.length === 0) continue;
            const base = {
                kind,
                kindLabel: template.label,
                fieldKey: field.key,
                fieldLabel: field.label,
                required: field.required,
                level: levels.get(field.key) ?? 1,
                elements: elements.length,
                empty: emptyOnes.length,
                dependents: dependentsOf(template.fields, field.key),
                relations: signals.relations,
                facts: signals.facts,
                citations: signals.citations,
                emptyElementIds: emptyOnes.slice(0, GAP_EMPTY_IDS_KEPT).map((e) => e.id),
            };
            const score = Math.round((gapWeight(base) * emptyOnes.length * 1000) / elements.length) / 1000;
            all.push({ ...base, score, kindRank: BIBLE_KINDS.indexOf(kind), order: field.order });
        }
    }
    all.sort((a, b) => b.score - a.score || a.kindRank - b.kindRank || a.order - b.order);
    return all.slice(0, max).map((c, i) => {
        const { kindRank, order, ...rest } = c;
        void kindRank;
        void order;
        return { ...rest, n: i + 1 };
    });
}

/** A candidate as one line of the prompt's `candidates` block (product words and counts). */
export function candidateLine(c: GapCandidate): string {
    const parts = [
        `${c.empty} of ${c.elements} ${c.elements === 1 ? 'element' : 'elements'} empty`,
        `${c.dependents} ${c.dependents === 1 ? 'field depends' : 'fields depend'} on it`,
        `${c.relations} relations, ${c.facts} facts, ${c.citations} citing entries for the kind`,
        c.required ? 'a core field' : 'an optional field',
    ];
    return `c${c.n}. ${c.kindLabel} › ${c.fieldLabel} (${parts.join('; ')})`;
}
