/**
 * THE RULES A DRAWN FACT IS HELD TO (Phase 4.0; rules 1, 2 and 4, D14). Pure.
 * Code decides what is kept; the model only proposes. In order, each refusal
 * a named, counted code (never a row):
 *
 *   INVALID_ITEM            the item did not parse
 *   OVER_LIMIT              past `FACTS_PER_CHUNK_MAX`
 *   SUBJECT_EMPTY           no subject once sanitised
 *   SUBJECT_NOT_IN_PASSAGE  the subject's name is not in the passage or its headings
 *   STATEMENT_EMPTY         no statement once sanitised
 *   QUOTE_NOT_FOUND         the quote is not one contiguous run of the passage (`locateQuote`)
 *   COPIES_INJECTED_TEXT    markup or a script scheme, an address the passage does not give,
 *                           the guard's injection hit, or eight words of the prompt
 *   NOT_GROUNDED            a sentence of the statement (or the object) is not supported by the quote
 *                           and the subject, or a story time the passage and its headings do not give
 *   POLARITY_CHANGED        the statement drops or adds a negation the quote has (`polarityKept`)
 *   DUPLICATE               the same predicate, subject and span twice
 *
 * A statement that addresses the product is NOT refused (D14): the fact is
 * kept with `POSSIBLE_INSTRUCTION`, shown as such, and never bulk-confirmed.
 * The stored quote is the passage's own slice at the located span.
 */
import { scanInjection } from '@/lib/ai/guard';
import { plainLine } from '@/lib/bible/text';
import { addressesTheProduct, groundingForm, nameKey, namedIn } from '@/lib/enrichment/validate';
import { groundSentence, sentences } from '@/lib/interview/text';
import { polarityKept } from '@/lib/text/negation';
import { disclosesInstructions, promptRuns } from '@/lib/text/prompt-disclosure';
import { addressesIn, sourceGivesAddress } from '@/lib/text/url-mentions';
import { EXTRACT_PROMPT } from './prompt';
import { locateQuote } from './quote';
import { FACTS_PER_CHUNK_MAX, OBJECT_MAX, parseFactsOutput, STATEMENT_MAX, STORY_TIME_MAX, SUBJECT_MAX, type FactOutput } from './schema';
import type { FactFlag, FactPredicate } from './vocabulary';

export const FACT_REFUSALS = [
    'INVALID_ITEM',
    'OVER_LIMIT',
    'SUBJECT_EMPTY',
    'SUBJECT_NOT_IN_PASSAGE',
    'STATEMENT_EMPTY',
    'QUOTE_NOT_FOUND',
    'COPIES_INJECTED_TEXT',
    'NOT_GROUNDED',
    'POLARITY_CHANGED',
    'DUPLICATE',
] as const;
export type FactRefusal = (typeof FACT_REFUSALS)[number];

export interface FactDraft {
    readonly position: number;
    readonly subjectName: string;
    readonly predicate: FactPredicate;
    readonly objectLiteral: string | null;
    readonly statement: string;
    readonly quote: string;
    readonly quoteStart: number;
    readonly quoteEnd: number;
    readonly storyTimeFrom: string | null;
    readonly storyTimeTo: string | null;
    readonly flags: FactFlag[];
}

export interface FactValidation {
    facts: FactDraft[];
    refusals: Partial<Record<FactRefusal, number>>;
    drafted: number;
}

const MARKUP = /<\s*[A-Za-z!/?]/;
const SCRIPT_SCHEME = /\b(?:javascript|data|vbscript)\s*:/i;
const EXTRACT_RUNS = promptRuns([EXTRACT_PROMPT]);

function clip(text: string, max: number): string {
    return text.length > max ? text.slice(0, max).trimEnd() : text;
}

/** A prompt's runs, as `disclosesInstructions` reads them (5.3's draft read holds its facts to these rules with its own prompt's). */
export type PromptRuns = ReturnType<typeof promptRuns>;

/** Does any part copy what a passage must not make us store (the header's COPIES_INJECTED_TEXT)? */
export function copiesInjected(parts: readonly string[], passage: string, runs: PromptRuns = EXTRACT_RUNS): boolean {
    if (disclosesInstructions(parts, runs)) return true;
    for (const part of parts) {
        if (MARKUP.test(part) || SCRIPT_SCHEME.test(part)) return true;
        for (const address of addressesIn(part)) if (!sourceGivesAddress(address, [passage])) return true;
        if (part !== '' && scanInjection(part).verdict !== 'clean') return true;
    }
    return false;
}

export function validateFacts(raw: unknown, passage: { text: string; headingPath: readonly string[] }, opts: { runs?: PromptRuns } = {}): FactValidation {
    const { items, malformed } = parseFactsOutput(raw);
    const refusals: Partial<Record<FactRefusal, number>> = {};
    const refuse = (code: FactRefusal, n = 1) => (refusals[code] = (refusals[code] ?? 0) + n);
    if (malformed > 0) refuse('INVALID_ITEM', malformed);
    const facts: FactDraft[] = [];
    const seen = new Set<string>();
    const context = [passage.text, ...passage.headingPath].join('\n');
    items.forEach((item: FactOutput, i) => {
        if (i >= FACTS_PER_CHUNK_MAX) return refuse('OVER_LIMIT');
        const rawParts = [item.subject, item.object, item.statement, item.storyTimeFrom, item.storyTimeTo];
        const subjectName = clip(plainLine(item.subject), SUBJECT_MAX);
        if (subjectName === '') return refuse('SUBJECT_EMPTY');
        if (!namedIn(subjectName, context)) return refuse('SUBJECT_NOT_IN_PASSAGE');
        const statement = clip(plainLine(item.statement), STATEMENT_MAX);
        if (statement === '') return refuse('STATEMENT_EMPTY');
        const span = locateQuote(item.quote, passage.text);
        if (!span) return refuse('QUOTE_NOT_FOUND');
        const quote = passage.text.slice(span.start, span.end);
        // Checked on the raw strings: a passage that injects markup is telling the model something, so it is never sanitised and kept.
        if (copiesInjected(rawParts, passage.text, opts.runs)) return refuse('COPIES_INJECTED_TEXT');
        const sources = [groundingForm(quote), groundingForm(subjectName)];
        const objectLiteral = clip(plainLine(item.object), OBJECT_MAX) || null;
        const groundedText = [statement, objectLiteral ?? ''].filter((t) => t !== '');
        if (!groundedText.every((t) => sentences(groundingForm(t)).every((s) => groundSentence(s, sources).supported))) return refuse('NOT_GROUNDED');
        // When it holds is shown with the fact: the passage (or its headings) must say it, never the model alone.
        const storyTimeFrom = clip(plainLine(item.storyTimeFrom), STORY_TIME_MAX) || null;
        const storyTimeTo = clip(plainLine(item.storyTimeTo), STORY_TIME_MAX) || null;
        const passageSources = [groundingForm(context)];
        if (![storyTimeFrom, storyTimeTo].every((t) => t === null || sentences(groundingForm(t)).every((s) => groundSentence(s, passageSources).supported))) return refuse('NOT_GROUNDED');
        if (!polarityKept(statement, [quote])) return refuse('POLARITY_CHANGED');
        const key = `${item.predicate}|${nameKey(subjectName)}|${span.start}:${span.end}`;
        if (seen.has(key)) return refuse('DUPLICATE');
        seen.add(key);
        facts.push({
            position: facts.length,
            subjectName,
            predicate: item.predicate,
            objectLiteral,
            statement,
            quote,
            quoteStart: span.start,
            quoteEnd: span.end,
            storyTimeFrom,
            storyTimeTo,
            flags: [statement, objectLiteral ?? ''].some((t) => addressesTheProduct(t)) ? ['POSSIBLE_INSTRUCTION'] : [],
        });
    });
    return { facts, refusals, drafted: items.length + malformed };
}
