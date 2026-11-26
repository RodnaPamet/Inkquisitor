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
import { addressesTheProduct, groundingForm, nameKey } from '@/lib/enrichment/validate';
import { plainLine } from '@/lib/bible/text';
import { groundSentence, normaliseText, sentences } from '@/lib/interview/text';
import { copiesInjected } from '@/lib/sources/validate';
import { THREAD_TITLE_MAX, type ThreadKind } from '@/lib/continuity/vocabulary';
import { disclosesInstructions, promptRuns } from '@/lib/text/prompt-disclosure';
import { locateQuote } from '@/lib/sources/quote';
import { validateFacts, type FactDraft } from '@/lib/sources/validate';
import { BIBLE_FACTS_PROMPT } from './prompt';
import { parseBibleFactsOutput, parseBibleThreadsOutput } from './schema';

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

/**
 * THE RULES A PROPOSED THREAD IS HELD TO (Phase 4.2, D28; rules 1, 2 and 4, D14). Pure. On the text the call was
 * SHOWN, as a fact is; in order, each refusal a counted code:
 *
 *   THREAD_QUOTE_NOT_FOUND   the quote is not one contiguous run of the text shown (and so of the entry)
 *   THREAD_TITLE_EMPTY       a new thread with no title once sanitised
 *   THREAD_COPIES_INJECTED   markup or a script scheme, an address the entry does not give, the guard's injection hit,
 *                            or eight words of the prompt, in its title or quote
 *   THREAD_NOT_GROUNDED      a sentence of the title is not supported by the quote
 *   THREAD_UNKNOWN           `paysOff` names no open thread shown, or one of another kind
 *   THREAD_DUPLICATE         the same thread (or the same pay-off) twice
 *
 * A title that addresses the product is NOT refused (D14): the proposal is FLAGGED and accepted only one by one.
 * The stored quote is the entry's own slice at the located span.
 */
export interface BibleThreadDraft {
    readonly op: 'NEW_THREAD' | 'SET_STATE';
    readonly kind: ThreadKind;
    /** A new thread's title (sanitised); null for a pay-off. */
    readonly title: string | null;
    /** A pay-off's open thread (0-based index into those shown); null for a new thread. */
    readonly paysOffIndex: number | null;
    readonly quote: string;
    readonly quoteStart: number;
    readonly quoteEnd: number;
    readonly flags: string[];
}

export function validateBibleThreads(
    raw: unknown,
    input: { sent: string; entry: string; openThreads: ReadonlyArray<{ kind: string }> },
): { threads: BibleThreadDraft[]; refusals: Record<string, number>; drafted: number } {
    const { items, malformed } = parseBibleThreadsOutput(raw);
    const refusals: Record<string, number> = {};
    const refuse = (code: string, n = 1) => (refusals[code] = (refusals[code] ?? 0) + n);
    if (malformed > 0) refuse('THREAD_INVALID_ITEM', malformed);
    const threads: BibleThreadDraft[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        if (!locateQuote(item.quote, input.sent)) {
            refuse('THREAD_QUOTE_NOT_FOUND');
            continue;
        }
        const span = locateQuote(item.quote, input.entry);
        if (!span) {
            refuse('THREAD_QUOTE_NOT_FOUND');
            continue;
        }
        const quote = input.entry.slice(span.start, span.end);
        if (copiesInjected([item.title, item.quote], input.sent) || disclosesInstructions([item.title, item.quote], RUNS)) {
            refuse('THREAD_COPIES_INJECTED');
            continue;
        }
        if (item.paysOff > 0) {
            const open = input.openThreads[item.paysOff - 1];
            if (!open || open.kind !== item.kind) {
                refuse('THREAD_UNKNOWN');
                continue;
            }
            const key = `pay:${item.paysOff}`;
            if (seen.has(key)) {
                refuse('THREAD_DUPLICATE');
                continue;
            }
            seen.add(key);
            threads.push({ op: 'SET_STATE', kind: item.kind, title: null, paysOffIndex: item.paysOff - 1, quote, quoteStart: span.start, quoteEnd: span.end, flags: [] });
            continue;
        }
        const clipped = plainLine(item.title);
        const title = clipped.length > THREAD_TITLE_MAX ? clipped.slice(0, THREAD_TITLE_MAX).trimEnd() : clipped;
        if (title === '') {
            refuse('THREAD_TITLE_EMPTY');
            continue;
        }
        const sources = [groundingForm(quote)];
        if (!sentences(groundingForm(title)).every((t) => groundSentence(t, sources).supported)) {
            refuse('THREAD_NOT_GROUNDED');
            continue;
        }
        const key = `new:${item.kind}:${normaliseText(title)}`;
        if (seen.has(key)) {
            refuse('THREAD_DUPLICATE');
            continue;
        }
        seen.add(key);
        threads.push({ op: 'NEW_THREAD', kind: item.kind, title, paysOffIndex: null, quote, quoteStart: span.start, quoteEnd: span.end, flags: addressesTheProduct(title) ? ['POSSIBLE_INSTRUCTION'] : [] });
    }
    return { threads, refusals, drafted: items.length + malformed };
}
