/**
 * THE RULES A BIBLE FACT IS HELD TO (Phase 4.1, D27). Pure.
 *
 * 4.0's rules, unchanged (`validateFacts`: the subject named in the passage,
 * the quote one contiguous run of it, no copied injection or prompt, every
 * sentence grounded in the quote and the subject, a story time the passage
 * gives, polarity kept; D14's product-addressing FLAG), applied to the text the
 * call was SHOWN (`sentText`: the entry's header and its changed sections),
 * one item at a time so each item's `contradicts` stays with it. Then:
 *
 *   SUBJECT_NOT_ENTRY      the subject is not the entry's own element (or, for a relation, one of its ends)
 *   QUOTE_NOT_IN_ENTRY     the quote is not in the version's whole rendered entry (it cannot be, if it is in
 *                          the text shown; checked so the stored span is always an offset into the entry)
 *   COPIES_INJECTED_TEXT   also eight words of THIS prompt (4.0's check knows its own)
 *
 * A `contradicts` number that names no fact shown is dropped (counted). Each
 * refusal is a counted code, never a row.
 */
import { nameKey } from '@/lib/enrichment/validate';
import { disclosesInstructions, promptRuns } from '@/lib/text/prompt-disclosure';
import { locateQuote } from '@/lib/sources/quote';
import { validateFacts, type FactDraft } from '@/lib/sources/validate';
import { BIBLE_FACTS_PROMPT } from './prompt';
import { parseBibleFactsOutput } from './schema';

export const BIBLE_FACT_REFUSALS = ['SUBJECT_NOT_ENTRY', 'QUOTE_NOT_IN_ENTRY', 'COPIES_INJECTED_TEXT', 'CONTRADICTS_UNKNOWN'] as const;

export interface BibleFactDraft extends FactDraft {
    /** The index (0-based) of the subject among the entry's subjects. */
    readonly subjectIndex: number;
    /** Indices (0-based) of the existing facts shown that it contradicts, by the model's judgement. */
    readonly contradicts: readonly number[];
}

export interface BibleFactValidation {
    facts: BibleFactDraft[];
    refusals: Record<string, number>;
    drafted: number;
}

const RUNS = promptRuns([BIBLE_FACTS_PROMPT]);

export function validateBibleFacts(
    raw: unknown,
    input: { sent: string; entry: string; headings: readonly string[]; subjects: readonly string[]; shown: number },
): BibleFactValidation {
    const { items, malformed } = parseBibleFactsOutput(raw);
    const refusals: Record<string, number> = {};
    const refuse = (code: string, n = 1) => (refusals[code] = (refusals[code] ?? 0) + n);
    if (malformed > 0) refuse('INVALID_ITEM', malformed);
    const subjectKeys = input.subjects.map((s) => nameKey(s));
    const facts: BibleFactDraft[] = [];
    for (const item of items) {
        const one = validateFacts({ facts: [item.fact] }, { text: input.sent, headingPath: [...input.headings] });
        for (const [code, n] of Object.entries(one.refusals)) refuse(code, n ?? 0);
        const draft = one.facts[0];
        if (!draft) continue;
        if (disclosesInstructions([item.fact.subject, item.fact.object, item.fact.statement, item.fact.storyTimeFrom, item.fact.storyTimeTo], RUNS)) {
            refuse('COPIES_INJECTED_TEXT');
            continue;
        }
        const subjectIndex = subjectKeys.indexOf(nameKey(draft.subjectName));
        if (subjectIndex < 0) {
            refuse('SUBJECT_NOT_ENTRY');
            continue;
        }
        // The stored span is an offset into the whole entry, never into the text shown.
        const span = locateQuote(draft.quote, input.entry);
        if (!span) {
            refuse('QUOTE_NOT_IN_ENTRY');
            continue;
        }
        const contradicts = item.contradicts.filter((n) => n >= 1 && n <= input.shown).map((n) => n - 1);
        if (contradicts.length < item.contradicts.length) refuse('CONTRADICTS_UNKNOWN', item.contradicts.length - contradicts.length);
        facts.push({
            ...draft,
            subjectName: input.subjects[subjectIndex],
            position: facts.length,
            quote: input.entry.slice(span.start, span.end),
            quoteStart: span.start,
            quoteEnd: span.end,
            subjectIndex,
            contradicts,
        });
    }
    return { facts, refusals, drafted: items.length + malformed };
}
