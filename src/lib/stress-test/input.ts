/**
 * WHAT A STRESS TEST IS SHOWN (Phase 4.3, D29), as data blocks, under ONE
 * character budget. Pure: the usecase reads the canon (through the 4.1
 * retriever for facts and passages) and hands it here in priority order; this
 * module decides what fits and, as importantly, SAYS WHAT WAS LEFT OUT
 * (`coverage`): a pass over part of a large book never reads as a pass over all
 * of it (rule 6).
 *
 * Every shown item gets a TAG (`E3`, `F12`, `T2`, `P1`), and `shown` maps each
 * tag to the row it stands for. The model cites by tag; `validate.ts` resolves
 * a tag only through this map, so a citation names a row the call was shown or
 * nothing at all.
 *
 *   book          the title and logline
 *   elements      the elements, each with its kind, name and (cut) summary; a
 *                 placed beat or event with its place in the story order
 *   story-order   each order's elements by tag, earliest first (code-made)
 *   facts         the live facts the retriever ranked (subject: statement)
 *   threads       the open threads: promises, clues, open questions
 *   passages.N    the passages of the book's sources the retriever ranked
 *
 * Shares of the budget, in order: elements 45 %, facts 25 %, threads 10 %,
 * passages the rest; what a block leaves unused passes to the next.
 */
import type { AuthorDataBlock } from '@/lib/ai/prompt';
import { truncateGraphemes } from '@/lib/text/truncate';
import {
    CITATION_TAG,
    STRESS_ELEMENTS_MAX,
    STRESS_FACTS_MAX,
    STRESS_PASSAGES_MAX,
    STRESS_SUMMARY_SHOWN_MAX_CHARS,
    STRESS_THREADS_MAX,
    type CitationType,
} from './vocabulary';

export interface StressElement {
    readonly id: string;
    readonly kind: string;
    readonly name: string;
    readonly summary: string | null;
    /** A placed element's place in its order: the order's name and its 1-based position. */
    readonly place?: { readonly order: string; readonly position: number } | null;
}

export interface StressFact {
    readonly id: string;
    readonly subject: string;
    readonly statement: string;
}

export interface StressThread {
    readonly id: string;
    readonly kind: string;
    readonly title: string;
}

export interface StressPassage {
    readonly id: string;
    readonly headings: string;
    readonly text: string;
}

export interface StressInputSources {
    readonly book: { readonly title: string; readonly logline: string | null };
    /** In priority order (the usecase's: premise, theme, characters, plot, …). */
    readonly elements: readonly StressElement[];
    readonly facts: readonly StressFact[];
    readonly threads: readonly StressThread[];
    readonly passages: readonly StressPassage[];
    /** Each order's placed element ids, earliest first. */
    readonly orders: ReadonlyArray<{ readonly order: string; readonly elementIds: readonly string[] }>;
    /** How many of each the book holds (or the reads found, a cut read counted as more): what "left out" is measured against. */
    readonly totals: { readonly elements: number; readonly facts: number; readonly threads: number; readonly passages: number };
}

export interface ShownRef {
    readonly type: CitationType;
    readonly id: string;
}

export interface CoverageCount {
    readonly shown: number;
    readonly total: number;
}

/** What the pass read and what it left out: counts only, no text (stored on the row, shown on the page). */
export interface StressCoverage {
    readonly elements: CoverageCount;
    readonly facts: CoverageCount;
    readonly threads: CoverageCount;
    readonly passages: CoverageCount;
    /** The budget the blocks were cut to, in characters. */
    readonly budgetChars: number;
    /** Something the book holds was not shown. */
    readonly cut: boolean;
}

export interface StressInput {
    readonly blocks: AuthorDataBlock[];
    readonly shown: ReadonlyMap<string, ShownRef>;
    readonly coverage: StressCoverage;
}

const SHARES = { elements: 0.45, facts: 0.25, threads: 0.1 } as const;

function lineOfElement(tag: string, e: StressElement): string {
    const summary = e.summary && e.summary.trim() !== '' ? truncateGraphemes(e.summary.trim().replace(/\s+/g, ' '), STRESS_SUMMARY_SHOWN_MAX_CHARS) : '(no summary)';
    const place = e.place ? ` (position ${e.place.position} of the ${e.place.order})` : '';
    return `${tag}. [${e.kind}] ${e.name.replace(/\s+/g, ' ')}${place}: ${summary}`;
}

/** Fit `lines` into `room` characters, in order; returns the lines kept and the characters used. */
function fit(lines: readonly string[], room: number, max: number): { kept: number; used: number } {
    let used = 0;
    let kept = 0;
    for (const line of lines.slice(0, max)) {
        const size = line.length + 1;
        if (used + size > room) break;
        used += size;
        kept++;
    }
    return { kept, used };
}

/** The blocks for this canon under `budgetChars` (the header). Pure and deterministic. */
export function buildStressInput(src: StressInputSources, budgetChars: number): StressInput {
    const shown = new Map<string, ShownRef>();
    const blocks: AuthorDataBlock[] = [];
    const bookText = `Title: ${src.book.title}${src.book.logline ? `\nLogline: ${src.book.logline}` : ''}`;
    blocks.push({ label: 'book', text: bookText });
    let carry = Math.max(0, budgetChars - bookText.length);
    const total = carry;

    // Elements: tags given in order to those that fit.
    const elementLines = src.elements.slice(0, STRESS_ELEMENTS_MAX).map((e, i) => lineOfElement(`${CITATION_TAG.ELEMENT}${i + 1}`, e));
    const el = fit(elementLines, Math.floor(total * SHARES.elements), STRESS_ELEMENTS_MAX);
    const tagOf = new Map<string, string>();
    src.elements.slice(0, el.kept).forEach((e, i) => {
        const tag = `${CITATION_TAG.ELEMENT}${i + 1}`;
        shown.set(tag, { type: 'ELEMENT', id: e.id });
        tagOf.set(e.id, tag);
    });
    if (el.kept > 0) blocks.push({ label: 'elements', text: elementLines.slice(0, el.kept).join('\n') });
    carry -= el.used;

    // The story order, by tag (only the elements shown).
    const orderLines = src.orders
        .map((o) => ({ order: o.order, tags: o.elementIds.map((id) => tagOf.get(id)).filter((t): t is string => t !== undefined) }))
        .filter((o) => o.tags.length > 0)
        .map((o) => `${o.order}, earliest first: ${o.tags.join(', ')}`);
    if (orderLines.length > 0) {
        const text = orderLines.join('\n');
        blocks.push({ label: 'story-order', text });
        carry -= text.length;
    }

    // Facts.
    const factLines = src.facts.slice(0, STRESS_FACTS_MAX).map((f, i) => `${CITATION_TAG.FACT}${i + 1}. ${f.subject.replace(/\s+/g, ' ')}: ${f.statement.replace(/\s+/g, ' ')}`);
    const fa = fit(factLines, Math.min(carry, Math.floor(total * (SHARES.elements + SHARES.facts)) - el.used), STRESS_FACTS_MAX);
    src.facts.slice(0, fa.kept).forEach((f, i) => shown.set(`${CITATION_TAG.FACT}${i + 1}`, { type: 'FACT', id: f.id }));
    if (fa.kept > 0) blocks.push({ label: 'facts', text: factLines.slice(0, fa.kept).join('\n') });
    carry -= fa.used;

    // Open threads.
    const threadLines = src.threads.slice(0, STRESS_THREADS_MAX).map((t, i) => `${CITATION_TAG.THREAD}${i + 1}. [${t.kind}] ${t.title.replace(/\s+/g, ' ')}`);
    const th = fit(threadLines, Math.min(carry, Math.floor(total * SHARES.threads) + Math.max(0, Math.floor(total * (SHARES.elements + SHARES.facts)) - el.used - fa.used)), STRESS_THREADS_MAX);
    src.threads.slice(0, th.kept).forEach((t, i) => shown.set(`${CITATION_TAG.THREAD}${i + 1}`, { type: 'THREAD', id: t.id }));
    if (th.kept > 0) blocks.push({ label: 'threads', text: threadLines.slice(0, th.kept).join('\n') });
    carry -= th.used;

    // Passages: the rest of the budget.
    let passagesKept = 0;
    for (const p of src.passages.slice(0, STRESS_PASSAGES_MAX)) {
        const tag = `${CITATION_TAG.PASSAGE}${passagesKept + 1}`;
        const text = `${tag}.${p.headings ? ` ${p.headings}` : ''}\n\n${p.text}`;
        if (text.length > carry) break;
        carry -= text.length;
        shown.set(tag, { type: 'PASSAGE', id: p.id });
        blocks.push({ label: `passages.${passagesKept + 1}`, text });
        passagesKept++;
    }

    const coverage: StressCoverage = {
        elements: { shown: el.kept, total: Math.max(src.totals.elements, el.kept) },
        facts: { shown: fa.kept, total: Math.max(src.totals.facts, fa.kept) },
        threads: { shown: th.kept, total: Math.max(src.totals.threads, th.kept) },
        passages: { shown: passagesKept, total: Math.max(src.totals.passages, passagesKept) },
        budgetChars,
        cut: false,
    };
    return {
        blocks,
        shown,
        coverage: {
            ...coverage,
            cut: [coverage.elements, coverage.facts, coverage.threads, coverage.passages].some((c) => c.shown < c.total),
        },
    };
}

/** The text the call was shown, for the quote check in `validate.ts` (every block joined). */
export function shownText(input: Pick<StressInput, 'blocks'>): string {
    return input.blocks.map((b) => b.text).join('\n');
}
