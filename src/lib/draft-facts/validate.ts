/**
 * THE RULES A DRAFT READ IS HELD TO (Phase 5.3; rules 1, 2 and 4, D14). Pure.
 *
 * FACTS are held to 4.0's rules exactly (`validateFacts`: subject named in the
 * passage, the quote one contiguous run of it, grounding, polarity, no copied
 * injection or prompt — this prompt's), on the PIECE the call was shown; each
 * kept fact's span is moved by the piece's offset into the scene's whole plain
 * text.
 *
 * THREAD LINKS, in order, each refusal a named, counted code (never a row):
 *
 *   INVALID_ITEM            the item did not parse
 *   OVER_LIMIT              past `LINKS_PER_CALL_MAX`
 *   UNKNOWN_THREAD          its number names no thread the call was shown
 *   QUOTE_NOT_FOUND         the quote is not one contiguous run of the piece (`locateQuote`)
 *   COPIES_INJECTED_TEXT    the quote holds markup, a script scheme, the guard's injection hit or eight words of the prompt
 *   DUPLICATE               the same thread and role twice in one call
 *
 * A quote that addresses the product is NOT refused (D14): the link is kept
 * with `POSSIBLE_INSTRUCTION`, shown as such, and decided one by one like every
 * other. The stored quote is the piece's own slice at the located span.
 */
import { addressesTheProduct } from '@/lib/enrichment/validate';
import { locateQuote } from '@/lib/sources/quote';
import { copiesInjected, validateFacts, type FactDraft, type FactRefusal } from '@/lib/sources/validate';
import { promptRuns } from '@/lib/text/prompt-disclosure';
import type { FactFlag } from '@/lib/sources/vocabulary';
import { DRAFT_READ_PROMPT } from './prompt';
import { parseThreadLinks } from './schema';
import { LINKS_PER_CALL_MAX, type LinkRole } from './vocabulary';

export const LINK_REFUSALS = ['INVALID_ITEM', 'OVER_LIMIT', 'UNKNOWN_THREAD', 'QUOTE_NOT_FOUND', 'COPIES_INJECTED_TEXT', 'DUPLICATE'] as const;
export type LinkRefusal = (typeof LINK_REFUSALS)[number];

const DRAFT_RUNS = promptRuns([DRAFT_READ_PROMPT]);

export interface LinkDraft {
    /** The index of the thread in the list the call was shown (0-based). */
    readonly threadIndex: number;
    readonly role: LinkRole;
    readonly quote: string;
    readonly quoteStart: number;
    readonly quoteEnd: number;
    readonly flags: FactFlag[];
}

export interface DraftReadValidation {
    facts: FactDraft[];
    links: LinkDraft[];
    factRefusals: Partial<Record<FactRefusal, number>>;
    linkRefusals: Partial<Record<LinkRefusal, number>>;
    drafted: number;
}

/**
 * One call's answer over the piece it was shown, `offset` characters into the scene's plain text: facts and links,
 * their spans moved into the whole text. `threadsShown` is how many threads the call was shown.
 */
export function validateDraftRead(raw: unknown, piece: { text: string; headingPath: readonly string[]; offset: number }, threadsShown: number): DraftReadValidation {
    const facts = validateFacts(raw, { text: piece.text, headingPath: piece.headingPath }, { runs: DRAFT_RUNS });
    const linkRefusals: Partial<Record<LinkRefusal, number>> = {};
    const refuse = (code: LinkRefusal, n = 1) => (linkRefusals[code] = (linkRefusals[code] ?? 0) + n);
    const { items, malformed } = parseThreadLinks(raw);
    if (malformed > 0) refuse('INVALID_ITEM', malformed);
    const links: LinkDraft[] = [];
    const seen = new Set<string>();
    items.forEach((item, i) => {
        if (i >= LINKS_PER_CALL_MAX) return refuse('OVER_LIMIT');
        if (!Number.isInteger(item.thread) || item.thread < 1 || item.thread > threadsShown) return refuse('UNKNOWN_THREAD');
        const span = locateQuote(item.quote, piece.text);
        if (!span) return refuse('QUOTE_NOT_FOUND');
        const quote = piece.text.slice(span.start, span.end);
        if (copiesInjected([item.quote], piece.text, DRAFT_RUNS)) return refuse('COPIES_INJECTED_TEXT');
        const key = `${item.thread}|${item.role}`;
        if (seen.has(key)) return refuse('DUPLICATE');
        seen.add(key);
        links.push({
            threadIndex: item.thread - 1,
            role: item.role,
            quote,
            quoteStart: span.start + piece.offset,
            quoteEnd: span.end + piece.offset,
            flags: addressesTheProduct(quote) ? ['POSSIBLE_INSTRUCTION'] : [],
        });
    });
    return {
        facts: facts.facts.map((f) => ({ ...f, quoteStart: f.quoteStart + piece.offset, quoteEnd: f.quoteEnd + piece.offset })),
        links,
        factRefusals: facts.refusals,
        linkRefusals,
        drafted: facts.drafted + items.length + malformed,
    };
}
