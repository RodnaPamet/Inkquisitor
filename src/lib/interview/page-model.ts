/**
 * What an interview page hands its client component about the book's
 * templates (Phase 2.4): the kinds' labels and, for the kinds a scope holds,
 * each field's label. Product text from the template registry, read on the
 * server (`src/lib/bible/ui-model.ts`), never the registry in the browser.
 */
import type { BibleKind } from '@/lib/bible/kinds';
import { fieldDefsFor, kindSummaries } from '@/lib/bible/ui-model';

export function kindLabels(): Record<BibleKind, string> {
    return Object.fromEntries(kindSummaries().map((k) => [k.kind, k.label])) as Record<BibleKind, string>;
}

export function fieldLabelsFor(kinds: Iterable<BibleKind>): Partial<Record<BibleKind, Record<string, string>>> {
    const out: Partial<Record<BibleKind, Record<string, string>>> = {};
    for (const kind of new Set(kinds)) out[kind] = Object.fromEntries(fieldDefsFor(kind).map((f) => [f.key, f.label]));
    return out;
}
