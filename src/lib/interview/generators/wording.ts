/**
 * HOW CODE WORDS A GENERATOR'S QUESTION (Phase 4.4, D23 and D30). Pure and
 * deterministic.
 *
 * The frontier's questions are worded by the model (QUESTION_PROMPT, 2.2,
 * unchanged). The four new generators' questions are worded HERE, by code,
 * from fixed templates over what the book already holds: a source question
 * quotes its source verbatim ("Your draft says Wren never learned to swim (ch.
 * 3). Is that canon?", D23), a contradiction quotes both facts' own words, a
 * ladder question names the field it follows up, a pair question names the two
 * elements. So nothing here invents story content (D3), every quoted word is the
 * author's own, and no call is made: the templates are the evaluation (their
 * unit tests hold each to the question rules of `candidates.ts` and to
 * deduplication, so two layers of one field never read as repeats).
 *
 * Every template ends in its one question mark: a `?` inside quoted author text
 * is written as the full-width `？` (U+FF1F), so the question still holds
 * exactly one (`validateCandidate`'s rule) without dropping the author's words.
 * Names and quotes are cut between grapheme clusters (`truncateGraphemes`) so a
 * question stays within `QUESTION_TEXT_MAX`.
 */
import { truncateGraphemes } from '@/lib/text/truncate';
import { QUESTION_TEXT_MAX } from '../candidates';
import type { LadderLayer, PairAngle } from '../vocabulary';

/** A name quoted in a question, at most (grapheme clusters). */
export const WORDED_NAME_MAX = 48;
/** A field label in a question, at most. */
export const WORDED_LABEL_MAX = 48;

/** The two options of a source question, fixed: the answer decides the fact (D30, item 2). */
export const SOURCE_YES = 'Yes, it is canon';
export const SOURCE_NO = 'No, it is not';
export const SOURCE_OPTIONS: readonly [string, string] = [SOURCE_YES, SOURCE_NO];

/** What code worded: the kind, the text and (for a source question) its two options. */
export interface WordedQuestion {
    kind: 'OPEN' | 'EITHER_OR';
    text: string;
    options: string[] | null;
}

/** Author text inside a question: one line, its `?` made full-width, cut to `max`. */
export function quoted(text: string, max: number): string {
    const line = text.replace(/\s+/g, ' ').trim().replace(/\?/g, '？');
    return truncateGraphemes(line, max);
}

function name(text: string): string {
    return quoted(text, WORDED_NAME_MAX);
}

function label(text: string): string {
    return quoted(text.toLowerCase(), WORDED_LABEL_MAX);
}

/** What a ladder question names: an element's field ("Wren’s conscious want") or a relation's ("the nature of the link for Wren and Ida"). */
export type LadderSubject = { kind: 'element'; name: string } | { kind: 'relation'; fromName: string; toName: string };

function fieldPhrase(subject: LadderSubject, fieldLabel: string): string {
    if (subject.kind === 'relation') return `the ${label(fieldLabel)} for ${name(subject.fromName)} and ${name(subject.toName)}`;
    return `${name(subject.name)}’s ${label(fieldLabel)}`;
}

/**
 * THE DEEPENING LADDER (D23): follow-ups on a field the author answered, layer by layer. Each layer's words are its
 * own, so two layers of one field never share enough to read as a repeat (`tests/unit/interview/generators.test.ts`
 * runs them through `dedupe`).
 */
export function ladderQuestion(layer: LadderLayer, subject: LadderSubject, fieldLabel: string): WordedQuestion {
    const f = fieldPhrase(subject, fieldLabel);
    const text: Record<LadderLayer, string> = {
        WHAT: `Which concrete moment in the story shows ${f} most clearly?`,
        WHY: `Where does ${f} come from, and what makes it matter so much?`,
        COST: `What price does ${f} exact, and who pays it?`,
        WHO_KNOWS: `Who else knows about ${f}, and who is kept from learning it?`,
        BREAKS: `What event or person could shatter ${f}?`,
        EDGE_CASES: `In which unusual situation would ${f} stop holding true?`,
    };
    return { kind: 'OPEN', text: text[layer], options: null };
}

/** THE RELATIONS GENERATOR'S PAIR QUESTIONS (D30, item 3): two elements of the scope with no relation yet. */
export function pairQuestion(angle: PairAngle, firstName: string, secondName: string): WordedQuestion {
    const a = name(firstName);
    const b = name(secondName);
    const text: Record<PairAngle, string> = {
        WANTS: `What does ${a} want from ${b}?`,
        COLLIDE: `Where do ${a} and ${b} collide, and what is at stake when they do?`,
        HIDDEN: `What does ${a} hide from ${b}, and for what reason?`,
    };
    return { kind: 'OPEN', text: text[angle], options: null };
}

/** The field a pair angle's answer fills on the relation it may lead to (`related_to`'s fields). */
export const PAIR_ANGLE_FIELD: Readonly<Record<PairAngle, 'nature' | 'significance'>> = Object.freeze({ WANTS: 'nature', COLLIDE: 'significance', HIDDEN: 'nature' });

/**
 * A SOURCE QUESTION (D23, D30 item 2): the source's own words, verbatim, and where they are; yes confirms the fact,
 * no rejects it. The quote takes whatever room the template leaves.
 */
export function sourceQuestion(quote: string, sourceName: string, where: string | null): WordedQuestion {
    const src = name(sourceName);
    const loc = where ? ` (${quoted(where, 40)})` : '';
    const frame = (q: string) => `Your source “${src}” says “${q}”${loc}. Is that canon?`;
    const room = Math.max(12, QUESTION_TEXT_MAX - frame('').length);
    return { kind: 'EITHER_OR', text: frame(quoted(quote, room)), options: [...SOURCE_OPTIONS] };
}

/** A CONTINUITY QUESTION about a contradiction 4.2 found: both facts' own words, and the subject they disagree about. */
export function contradictionQuestion(subjectName: string, olderQuote: string, newerQuote: string): WordedQuestion {
    const n = name(subjectName);
    const frame = (a: string, b: string) => `Your bible holds “${a}” and also “${b}”. Which is true for ${n}, or how can both hold?`;
    const room = Math.max(12, Math.floor((QUESTION_TEXT_MAX - frame('', '').length) / 2));
    return { kind: 'OPEN', text: frame(quoted(olderQuote, room), quoted(newerQuote, room)), options: null };
}

/** A CONTINUITY QUESTION about an open thread (an unpaid promise, an unfound clue, an open question). */
export function threadQuestion(kind: 'PROMISE' | 'CLUE' | 'OPEN_QUESTION', title: string): WordedQuestion {
    const t = quoted(title, 120);
    const text = {
        PROMISE: `The promise “${t}” is still open: how and where is it paid off?`,
        CLUE: `The clue “${t}” is still open: where is it found, and what does it point to?`,
        OPEN_QUESTION: `The open question “${t}” has no answer yet: what is the answer?`,
    }[kind];
    return { kind: 'OPEN', text, options: null };
}

/** A CONTINUITY QUESTION about a timeline gap: an event with no story time between two that have one. */
export function timelineGapQuestion(eventName: string, before: { name: string; time: string }, after: { name: string; time: string }): WordedQuestion {
    return {
        kind: 'OPEN',
        text: `When does ${name(eventName)} happen, between ${name(before.name)} (${quoted(before.time, 30)}) and ${name(after.name)} (${quoted(after.time, 30)})?`,
        options: null,
    };
}
