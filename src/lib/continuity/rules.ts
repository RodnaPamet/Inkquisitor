/**
 * THE RULE DETECTORS (Phase 4.2, D28): two live facts that cannot both hold,
 * seen by code alone. Pure and deterministic. Rules come first; the nightly
 * deep check (a model) comes second and only for what rules cannot see.
 *
 * Every rule needs the SAME SUBJECT ELEMENT (a linked subject; a name alone is
 * never enough) and is deliberately narrow: a false alarm costs the author a
 * decision, a miss is still open to the deep check.
 *
 *   VALUE        the same single-valued predicate — an AGE (the first number), an
 *                OCCUPATION, a PLACE_TYPE — whose value plainly differs (objects
 *                that differ and neither holds the other) at an OVERLAPPING story
 *                time (`story-clock.ts`). A ROLE or a WANT can hold several values,
 *                so code never calls two of them contradictory. Since 5.3 (the
 *                roadmap's "eye colour") also two APPEARANCE facts that give ONE
 *                colour each to the same feature (eyes, hair, beard, skin), from a
 *                closed list of colours, and the colours differ: an appearance
 *                holds many things, so only a colour of one feature is compared
 *                (`appearanceColours`), never "tall" against "scarred".
 *   WHEREABOUTS  two LOCATIONs of one subject that plainly differ at a story
 *                time BOTH facts place (D28 addendum): someone in two places at
 *                once. With the story order, "at the mill" in beat 3 and "in the
 *                city" in beat 5 are two times, not a contradiction. A location
 *                with no story time and no position clashes with nothing here: a
 *                traveller's many undated whereabouts made a pair of every two,
 *                tens of thousands for one subject; the deep check judges them.
 *   KNOWLEDGE    who knows what when: two KNOWLEDGE facts of one subject about the
 *                SAME proposition (the statement's content words, negation removed)
 *                with OPPOSITE polarity, when both times decide they overlap — or
 *                when the subject KNOWS it at a point BEFORE a point where they do
 *                NOT (knowledge is not unlearned). Not knowing first and knowing
 *                later is learning. Undated, it is left to the deep check too.
 *
 * VALUE keeps "unknown overlaps everything" (decided with the addendum): a
 * single-valued predicate holds few distinct values per subject (one claim per
 * value), so it does not blow up, and two undated ages that differ are, nearly
 * always, the very slip the rule exists to catch.
 *
 * PRECISION (4.H-b, roadmap 4.H item 2): the rules are graded over a set of
 * seeded contradictions and near misses (`evals/rule-precision.json`, held at
 * precision ≥ 0.9 by a unit test), and four near misses the set found are
 * refused here, each narrowly — a refusal leaves the pair to the deep check:
 *
 *   • a NEGATED value is no value ("Marrow is not a miller" says nothing
 *     about whether he is a smith), so it takes part in no VALUE or
 *     WHEREABOUTS rule — negated meaning a negating word BEFORE the value in
 *     the clause that states it (the 4.H-b review: a negation elsewhere in
 *     the statement, "Wren, who never married, is a baker", negates nothing
 *     the rule compares);
 *   • two values are compared only when they have the SAME SHAPE — both names
 *     ("Paris", "the Iron Keep") or both descriptions ("the mill", "a smith"):
 *     a name and a description may be the same thing ("Paris" and "the capital
 *     of France"), which code cannot know;
 *   • values are compared with their accents folded ("Zürich" is "Zurich");
 *   • an AGE stated relative to someone ("3 years younger than Tomas") is
 *     not an age — relative meaning a comparative bound to the number in its
 *     own clause ("3 years younger", "younger than"), never a comparative
 *     anywhere in the statement ("Wren, 12, is younger than Tomas" states 12);
 *   • a KNOWLEDGE proposition keeps its question word: knowing THAT the deed was
 *     forged is not knowing WHO forged it — a question word right after the
 *     verb of knowing, never a relative pronoun ("the man who forged it").
 *
 * Synonyms of one shape ("a physician", "a doctor") are still raised: no rule
 * can tell them apart without a thesaurus, and the set counts that false alarm.
 * The owner decided (2026-11-27, D32 addendum B) that the rules get no synonym
 * list: such pairs are the deep continuity check's, and the false alarm stands.
 *
 * A pair is reported once, older first by the caller's order. Nothing here
 * writes: the caller PROPOSES (rule 1).
 */
import { nameKey } from '@/lib/enrichment/validate';
import { contentTokens, normaliseText, sentences, words } from '@/lib/interview/text';
import { negated, polarisedTokens } from '@/lib/text/negation';
import { before, decidedOverlap, overlaps, NO_ORDER, type ClockFact, type StoryClock } from './story-clock';
import type { ContradictionKind } from './vocabulary';

export interface RuleFact extends ClockFact {
    readonly id: string;
    readonly predicate: string;
    readonly subjectElementId: string | null;
    readonly objectLiteral: string | null;
    readonly statement: string;
}

/** The predicates a VALUE rule may call contradictory (4.1's list, LOCATION moved to WHEREABOUTS; APPEARANCE since 5.3, by colour only). */
export const VALUE_PREDICATES: ReadonlySet<string> = new Set(['AGE', 'OCCUPATION', 'PLACE_TYPE', 'APPEARANCE']);

/** The features an appearance's colour is compared for (5.3), each by its own words. */
const COLOUR_FEATURES: Readonly<Record<string, string>> = { eye: 'eyes', eyes: 'eyes', hair: 'hair', beard: 'beard', skin: 'skin' };
/** The colours compared (closed; "dark", "pale" and "light" are shades, never compared), each by its key. */
const COLOURS: Readonly<Record<string, string>> = {
    black: 'black', blue: 'blue', brown: 'brown', green: 'green', grey: 'grey', gray: 'grey', hazel: 'hazel', amber: 'amber',
    red: 'red', white: 'white', blond: 'blond', blonde: 'blond', auburn: 'auburn', golden: 'golden', silver: 'silver', violet: 'violet',
};
const LINKING = new Set(['is', 'are', 'was', 'were']);

/**
 * The colour an appearance gives each feature (5.3): a colour word at most two words before the feature ("grey
 * eyes", "bright green eyes") or right after the feature and a linking verb ("her eyes were green"). A feature given
 * two colours ("grey-green eyes", "black and grey hair") gives none: it is not one value. Bounded word lists only.
 */
export function appearanceColours(text: string): Map<string, string> {
    const ws = text.toLowerCase().match(/\p{L}+/gu) ?? [];
    const found = new Map<string, Set<string>>();
    ws.forEach((w, i) => {
        const feature = COLOUR_FEATURES[w];
        if (!feature) return;
        const near = new Set<string>();
        for (const j of [i - 1, i - 2]) if (j >= 0 && COLOURS[ws[j]]) near.add(COLOURS[ws[j]]);
        if (LINKING.has(ws[i + 1] ?? '') && COLOURS[ws[i + 2] ?? '']) near.add(COLOURS[ws[i + 2]]);
        if (near.size === 0) return;
        const set = found.get(feature) ?? new Set<string>();
        for (const c of near) set.add(c);
        found.set(feature, set);
    });
    const out = new Map<string, string>();
    for (const [feature, colours] of found) if (colours.size === 1) out.set(feature, [...colours][0]);
    return out;
}

/** Two appearances that give one feature two different colours (neither negated). */
function appearanceClash(a: RuleFact, b: RuleFact): boolean {
    if (negated(a.statement) || negated(b.statement)) return false;
    const ca = appearanceColours(`${a.statement} ${a.objectLiteral ?? ''}`);
    const cb = appearanceColours(`${b.statement} ${b.objectLiteral ?? ''}`);
    for (const [feature, colour] of ca) {
        const other = cb.get(feature);
        if (other !== undefined && other !== colour) return true;
    }
    return false;
}

function firstNumber(text: string): string | null {
    return /\d+(?:\.\d+)?/.exec(text)?.[0] ?? null;
}

/**
 * A comparative BOUND TO A NUMBER makes an age relative (4.H-b): "3 years younger", "younger than". Bounded
 * repetitions only (no quadratic backtracking on a long run of digits or spaces).
 */
const RELATIVE_AGE_AFTER_NUMBER = /\b\d{1,3}(?:\.\d{1,2})?\s{1,3}(?:(?:years?|yrs?)\s{1,3})?(?:older|younger|elder|senior|junior)\b/i;
const RELATIVE_COMPARATIVE = /\b(?:older|younger|elder|senior|junior)\s{1,3}than\b/i;

/**
 * A statement's clauses, for finding the clause that states a value: cut at a comma, colon or semicolon, or a
 * contrasting conjunction — but never at "yet", which in "not yet 13" belongs to the negation.
 */
const VALUE_CLAUSE_BREAK = /[;:,]|\s\b(?:but|although|though|whereas|while|however)\b/i;
function clauses(text: string): string[] {
    return sentences(text)
        .flatMap((x) => x.split(VALUE_CLAUSE_BREAK))
        .map((c) => c.trim())
        .filter((c) => c !== '');
}

/** Is the age `n` relative in `text`: does a clause of it that holds `n` bind a comparative to it? */
function relativeIn(text: string, n: string): boolean {
    const whole = n.split('.')[0];
    return clauses(text).some((c) => words(normaliseText(c)).includes(whole) && (RELATIVE_AGE_AFTER_NUMBER.test(c) || RELATIVE_COMPARATIVE.test(c)));
}

/** A stated age, or null: the first number of the value (else the statement), unless it is relative to someone. */
export function absoluteAge(f: Pick<RuleFact, 'objectLiteral' | 'statement'>): number | null {
    const text = f.objectLiteral || f.statement;
    const n = firstNumber(text);
    if (n === null || relativeIn(text, n) || relativeIn(f.statement, n)) return null;
    return Number(n);
}

/**
 * Is the VALUE a fact states negated (4.H-b, narrowed by its review)? True when a negating word comes before the
 * value in a clause of the statement that holds it ("Marrow is not a miller", "Wren is not yet 13"); a negation in
 * another clause ("Wren, who never married, is a baker") or after the value negates nothing the rules compare. A
 * value the statement does not hold is judged by the statement as a whole (a refusal, never a false alarm).
 */
export function valueNegated(f: Pick<RuleFact, 'predicate' | 'objectLiteral' | 'statement'>): boolean {
    const value = f.predicate === 'AGE' ? (firstNumber(f.objectLiteral || f.statement) ?? '') : (f.objectLiteral ?? '');
    const wanted = contentTokens(value);
    if (wanted.length === 0) return negated(f.statement);
    let stated = false;
    for (const clause of clauses(f.statement)) {
        const polarity = polarisedTokens(clause);
        for (const t of wanted) {
            if (!polarity.has(t)) continue;
            if (polarity.get(t)) return true;
            stated = true;
        }
    }
    return stated ? false : negated(f.statement);
}

/** A value's key with its accents folded (4.H-b: "Zürich" is "Zurich"). */
function foldedKey(value: string): string {
    return nameKey(value.normalize('NFD').replace(/\p{M}/gu, ''));
}

/**
 * A value's SHAPE (4.H-b): a NAME when its first word (after a leading article) is written with a capital ("Paris",
 * "the Iron Keep", "Free City of Harrow"), else a DESCRIPTION ("the mill", "a smith", "the capital of France").
 */
export function valueShape(value: string): 'NAME' | 'DESCRIPTION' | null {
    const ws = value.normalize('NFKC').trim().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
    const rest = ['the', 'a', 'an'].includes(ws[0]?.toLowerCase() ?? '') ? ws.slice(1) : ws;
    if (rest.length === 0) return null;
    return /^\p{Lu}/u.test(rest[0]) ? 'NAME' : 'DESCRIPTION';
}

function valuesDiffer(a: RuleFact, b: RuleFact): boolean {
    // A negated value states what is NOT so, never a value (4.H-b).
    if (valueNegated(a) || valueNegated(b)) return false;
    if (a.predicate === 'AGE') {
        const x = absoluteAge(a);
        const y = absoluteAge(b);
        return x !== null && y !== null && x !== y;
    }
    const sa = valueShape(a.objectLiteral ?? '');
    const sb = valueShape(b.objectLiteral ?? '');
    // A name and a description may name one thing ("Paris", "the capital of France"): not code's to call (4.H-b).
    if (sa === null || sb === null || sa !== sb) return false;
    const x = foldedKey(a.objectLiteral ?? '');
    const y = foldedKey(b.objectLiteral ?? '');
    if (x === '' || y === '') return false;
    return x !== y && !x.includes(y) && !y.includes(x);
}

/** The words a negation is made of: removed before a proposition is compared. */
const NEGATORS: ReadonlySet<string> = new Set(['not', 'no', 'never', 'cannot', 'nor', 'neither', 'nobody', 'none', 'nothing', 'nowhere', 'noone']);

function isNegator(word: string): boolean {
    const w = word.toLowerCase().replace(/’/g, "'");
    return NEGATORS.has(w) || w.endsWith("n't");
}

/** Question words kept in a proposition (4.H-b): knowing that the deed was forged is not knowing who forged it. */
const QUESTION_WORDS: ReadonlySet<string> = new Set(['who', 'whom', 'whose', 'what', 'which', 'where', 'when', 'why', 'how', 'whether']);
/** The verbs of knowing a question word follows ("knows who", "did not learn where"). */
const KNOWING = /^(?:know|knows|knew|known|knowing|learn|learns|learned|learnt|discover|discovers|discovered|realise|realises|realised|realize|realizes|realized|understand|understands|understood|suspect|suspects|suspected|wonder|wonders|wondered|guess|guesses|guessed)$/;

/**
 * The question words a statement asks, each right after a verb of knowing (at most one word between: "knows exactly
 * where"). A relative pronoun ("knows the man who forged it") is not asked: it names, as "that" would.
 */
function askedWords(statement: string): string[] {
    const ws = statement.toLowerCase().match(/\p{L}+(?:['’]\p{L}+)*/gu) ?? [];
    return ws.filter((w, i) => QUESTION_WORDS.has(w) && ((i >= 1 && KNOWING.test(ws[i - 1])) || (i >= 2 && KNOWING.test(ws[i - 2]))));
}

/** A statement's proposition: its content words and question words without its negation, sorted (what is known, whoever says it how). */
export function propositionKey(statement: string): string {
    const kept = statement.split(/\s+/).filter((w) => !isNegator(w.replace(/[^\p{L}\p{N}'’]/gu, ''))).join(' ');
    return [...new Set([...contentTokens(kept), ...askedWords(kept).map((w) => `?${w}`)])].sort().join(' ');
}

/** Could code alone call these two facts contradictory, and how? Null when it cannot. */
export function ruleContradiction(a: RuleFact, b: RuleFact, clock: StoryClock = NO_ORDER): ContradictionKind | null {
    if (a.id === b.id || a.predicate !== b.predicate) return null;
    if (a.subjectElementId === null || a.subjectElementId !== b.subjectElementId) return null;
    if (a.predicate === 'APPEARANCE') return overlaps(a, b, clock) && appearanceClash(a, b) ? 'VALUE' : null;
    if (VALUE_PREDICATES.has(a.predicate)) return overlaps(a, b, clock) && valuesDiffer(a, b) ? 'VALUE' : null;
    // D28 addendum: two whereabouts clash only when BOTH times decide that they overlap (never "unknown overlaps").
    if (a.predicate === 'LOCATION') return decidedOverlap(a, b, clock) === true && valuesDiffer(a, b) ? 'WHEREABOUTS' : null;
    if (a.predicate === 'KNOWLEDGE') {
        const na = negated(a.statement);
        const nb = negated(b.statement);
        if (na === nb) return null;
        const pa = propositionKey(a.statement);
        if (pa === '' || pa !== propositionKey(b.statement)) return null;
        if (decidedOverlap(a, b, clock) === true) return 'KNOWLEDGE';
        const knows = na ? b : a;
        const doesNot = na ? a : b;
        return before(knows, doesNot, clock) ? 'KNOWLEDGE' : null;
    }
    return null;
}

export interface RulePair {
    readonly a: string;
    readonly b: string;
    readonly kind: ContradictionKind;
}

/**
 * Every pair of `facts` a rule calls contradictory. Facts are grouped by subject element first (a rule never crosses
 * subjects), so the work is the sum of each group's pairs, not the whole set's; `maxGroup` bounds a group (a subject
 * past it is checked on its first `maxGroup` facts and counted in `cut`).
 */
export function detectRuleContradictions(facts: readonly RuleFact[], clock: StoryClock = NO_ORDER, maxGroup = 400): { pairs: RulePair[]; compared: number; cut: number } {
    const groups = new Map<string, RuleFact[]>();
    for (const f of facts) {
        if (!f.subjectElementId) continue;
        const g = groups.get(f.subjectElementId);
        if (g) g.push(f);
        else groups.set(f.subjectElementId, [f]);
    }
    const pairs: RulePair[] = [];
    let compared = 0;
    let cut = 0;
    for (const group of groups.values()) {
        const g = group.length > maxGroup ? group.slice(0, maxGroup) : group;
        cut += group.length - g.length;
        for (let i = 0; i < g.length; i++) {
            for (let j = i + 1; j < g.length; j++) {
                compared++;
                const kind = ruleContradiction(g[i], g[j], clock);
                if (kind) pairs.push({ a: g[i].id, b: g[j].id, kind });
            }
        }
    }
    return { pairs, compared, cut };
}
