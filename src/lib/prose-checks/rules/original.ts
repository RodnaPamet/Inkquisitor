/**
 * The ORIGINAL rules (Phase 5.2, D34): written for this product, every word
 * list included. Each is conservative on purpose — 5.H samples findings and
 * retunes any rule under 70 % useful — so each says in its own comment where
 * it stops. Pure functions of a `RuleContext`.
 */
import { STOP_WORDS, foldWord } from '@/lib/search/analyse';
import { firstNameOf, similarNamePairs } from '../similar-names';
import { inCaseOf, variantFor } from '../spelling-variants';
import type { Word } from '../segments';
import type { FindingDraft, RuleContext } from './types';

const set = (words: string): ReadonlySet<string> => new Set(words.split(' ').filter(Boolean));

/** Subject pronouns a filter verb or a tense slip follows. */
const SUBJECT_PRONOUNS = set('i you he she it we they');
/** One word that may stand between a subject and its verb ("she could see", "he suddenly felt"). */
const BRIDGES = set('could would suddenly then just finally slowly still also now barely only almost already distinctly clearly');
/** The bridges a tense slip may cross: adverbs only (after a modal, "could see" is the past's own form). */
const TENSE_BRIDGES = set('suddenly then just finally slowly still also now barely only almost already always never often sometimes');

// ─── Filter words ───────────────────────────────────────────────────

/**
 * Verbs that put a perceiving mind between the reader and the thing perceived
 * ("she saw the door open" for "the door opened"). FLAGGED ONLY RIGHT AFTER A
 * SUBJECT — a pronoun or a character's first name, with at most one bridging
 * word — so "the saw", "a feel for it" and "what he knew best was" reasons stay
 * quiet, and only in narration (a character may say "I saw him").
 */
const FILTER_VERBS = set(
    'see sees saw seeing watch watches watched hear hears heard feel feels felt notice notices noticed realise realises realised realize realizes realized ' +
        'wonder wonders wondered know knows knew seem seems seemed smell smells smelled smelt taste tastes tasted think thinks thought',
);

/** Is the word at `pos` placed as a speech or thought tag: right after a comma, a closing mark or a dash? */
function isTagPosition(text: string, pos: number): boolean {
    let i = pos - 1;
    while (i >= 0 && text[i] === ' ') i--;
    return i >= 0 && /[,”"’'»›—–]/.test(text[i]);
}

export function filterWords(ctx: RuleContext): FindingDraft[] {
    const names = new Set(ctx.characters.map((c) => firstNameOf(c.name)).filter((n) => n.length > 1));
    const out: FindingDraft[] = [];
    const words = ctx.seg.words;
    for (let i = 1; i < words.length; i++) {
        ctx.work.ops++;
        const w = words[i];
        if (!FILTER_VERBS.has(w.surface) || w.speech) continue;
        let s = i - 1;
        if (BRIDGES.has(words[s].surface) && s > 0 && words[s].sentence === w.sentence) s--;
        const subject = words[s];
        if (subject.sentence !== w.sentence || subject.speech) continue;
        // A tag after speech or a thought (", she thought", "” he heard") reports the words, it does not filter a perception.
        if (isTagPosition(ctx.text, subject.start)) continue;
        const isSubject = SUBJECT_PRONOUNS.has(subject.surface) || (names.has(subject.surface) && /^\p{Lu}/u.test(subject.raw));
        if (!isSubject) continue;
        out.push({ ruleId: 'filter-words', start: w.start, end: w.end, params: { word: w.raw } });
    }
    return out;
}

// ─── Overused words ─────────────────────────────────────────────────

/** A scene shorter than this is not compared with the book (its counts are noise). */
export const OVERUSED_MIN_SCENE_WORDS = 300;
/** The book must hold at least this many words, and twice the scene's, to be a baseline. */
export const OVERUSED_MIN_BOOK_WORDS = 2_000;
/** A word must occur at least this often in the scene. */
export const OVERUSED_MIN_COUNT = 4;
/** …at this many times its rate per 10,000 words in the book. */
export const OVERUSED_RATIO = 3;
/** At most this many overused words a scene, the most overused first. */
export const OVERUSED_PER_SCENE_MAX = 5;

/** A content word: four letters or more, not a function word, not a number. */
export function isContentWord(w: Pick<Word, 'surface'>): boolean {
    return w.surface.length >= 4 && !STOP_WORDS.has(w.surface) && !/^\p{N}+$/u.test(w.surface);
}

export function overusedWords(ctx: RuleContext): FindingDraft[] {
    const b = ctx.baseline;
    const words = ctx.seg.words;
    if (!b || words.length < OVERUSED_MIN_SCENE_WORDS || b.totalWords < Math.max(OVERUSED_MIN_BOOK_WORDS, 2 * words.length)) return [];
    const names = new Set(ctx.characters.flatMap((c) => c.name.split(/\s+/).map((p) => firstNameOf(p))));
    const counts = new Map<string, { count: number; first: Word }>();
    for (const w of words) {
        ctx.work.ops++;
        if (!isContentWord(w) || names.has(w.surface)) continue;
        const c = counts.get(w.stem);
        if (c) c.count++;
        else counts.set(w.stem, { count: 1, first: w });
    }
    const hits: Array<{ ratio: number; count: number; first: Word; sceneRate: number; bookRate: number }> = [];
    for (const [stem, { count, first }] of counts) {
        if (count < OVERUSED_MIN_COUNT) continue;
        // The book holds the scene, so its count is at least the scene's; a stem past the kept list counts at most `minKept` (assumed: fewer notes, never more).
        const bookCount = Math.max(count, b.counts[stem] ?? b.minKept);
        const sceneRate = (count / words.length) * 10_000;
        const bookRate = (bookCount / b.totalWords) * 10_000;
        const ratio = sceneRate / bookRate;
        if (ratio >= OVERUSED_RATIO) hits.push({ ratio, count, first, sceneRate, bookRate });
    }
    hits.sort((x, y) => y.ratio - x.ratio || x.first.start - y.first.start);
    return hits.slice(0, OVERUSED_PER_SCENE_MAX).map((h) => ({
        ruleId: 'overused-words' as const,
        start: h.first.start,
        end: h.first.end,
        params: { word: h.first.raw.toLowerCase(), count: h.count, sceneRate: Math.round(h.sceneRate), bookRate: Math.round(h.bookRate * 10) / 10 },
    }));
}

// ─── Repeated openers ───────────────────────────────────────────────

/** Consecutive narration sentences opening with the same word before a note (the third). */
export const OPENER_RUN = 3;

/** Three narration sentences in a row opening with the same word: one note at the third, however long the run. A sentence that opens in speech breaks the run. */
export function repeatedOpeners(ctx: RuleContext): FindingDraft[] {
    const out: FindingDraft[] = [];
    let opener = '';
    let run = 0;
    for (const s of ctx.seg.sentences) {
        ctx.work.ops++;
        const first = s.firstWord >= 0 ? ctx.seg.words[s.firstWord] : null;
        if (!first || first.speech || first.start - s.start > 2) {
            opener = '';
            run = 0;
            continue;
        }
        if (first.surface === opener) run++;
        else {
            opener = first.surface;
            run = 1;
        }
        if (run === OPENER_RUN) out.push({ ruleId: 'repeated-openers', start: first.start, end: first.end, params: { word: first.raw, count: OPENER_RUN } });
    }
    return out;
}

// ─── Similar character names ────────────────────────────────────────

/** Two characters whose names look or sound alike, BOTH named in this scene: one note at the later one's first appearance. */
export function similarNames(ctx: RuleContext): FindingDraft[] {
    if (ctx.characters.length < 2) return [];
    const firstAt = new Map<string, Word>();
    for (const w of ctx.seg.words) {
        ctx.work.ops++;
        if (!firstAt.has(w.surface) && /^\p{Lu}/u.test(w.raw)) firstAt.set(w.surface, w);
    }
    const out: FindingDraft[] = [];
    for (const pair of similarNamePairs(ctx.characters)) {
        ctx.work.ops++;
        const a = firstAt.get(firstNameOf(pair.a.name));
        const b = firstAt.get(firstNameOf(pair.b.name));
        if (!a || !b || pair.why === 'SAME_FIRST_NAME') continue;
        const later = a.start > b.start ? a : b;
        const earlier = later === a ? b : a;
        out.push({ ruleId: 'similar-names', start: later.start, end: later.end, params: { name: later.raw, other: earlier.raw, why: pair.why } });
    }
    return out;
}

// ─── Tense slips ────────────────────────────────────────────────────

const PRESENT_AFTER_SINGULAR = set(
    'is has does says goes comes looks turns walks knows thinks wants takes sees feels seems gets makes stands sits runs tells asks gives hears keeps leaves finds holds opens smiles nods shakes steps reaches pulls pushes watches waits tries needs likes loves hates laughs sighs whispers shouts starts stops',
);
const PRESENT_AFTER_OTHERS = set(
    'am are have do say go come look turn walk know think want take see feel seem get make stand sit run tell ask give hear keep leave find hold open smile nod shake step reach pull push watch wait try need like love hate laugh sigh whisper shout start stop',
);
/** Contractions that are present tense whatever follows ("she's" is left alone: it may be "she has" in a past perfect). */
const PRESENT_CONTRACTIONS = set("i'm you're we're they're");
const PAST_FORMS = set(
    'was were had did said went came looked turned walked knew thought wanted took saw felt seemed got made stood sat ran told asked gave heard kept left found held opened smiled nodded shook stepped reached pulled pushed watched waited tried needed liked loved hated laughed sighed whispered shouted started stopped',
);
const SINGULAR_THIRD = set('he she it');

/**
 * A narration verb in the other tense right after a subject pronoun (one
 * adverb may stand between), against the sheet's tense: "she walks" in a past
 * narration, "he said" in a present one. Closed verb lists, so an unlisted
 * verb is never flagged; speech and italic runs (thought, emphasis) are never
 * read. It cannot tell a retrospective narrator's present ("I remember") or a
 * flashback's past from a slip: a note, dismissable, never an edit.
 */
export function tenseSlips(ctx: RuleContext): FindingDraft[] {
    const tense = ctx.sheet.tense;
    if (!tense) return [];
    const out: FindingDraft[] = [];
    const words = ctx.seg.words;
    for (let i = 0; i < words.length; i++) {
        ctx.work.ops++;
        const w = words[i];
        if (w.speech || w.italic) continue;
        if (tense === 'past' && PRESENT_CONTRACTIONS.has(w.raw.toLowerCase().replace(/’/g, "'"))) {
            out.push({ ruleId: 'tense-slip', start: w.start, end: w.end, params: { word: w.raw, expected: tense } });
            continue;
        }
        if (i === 0) continue;
        let s = i - 1;
        if (TENSE_BRIDGES.has(words[s].surface) && s > 0 && words[s].sentence === w.sentence) s--;
        const subject = words[s];
        if (subject.sentence !== w.sentence || !SUBJECT_PRONOUNS.has(subject.surface) || subject.speech || subject.italic) continue;
        const slip =
            tense === 'past'
                ? SINGULAR_THIRD.has(subject.surface)
                    ? PRESENT_AFTER_SINGULAR.has(w.surface)
                    : PRESENT_AFTER_OTHERS.has(w.surface)
                : PAST_FORMS.has(w.surface);
        if (slip) out.push({ ruleId: 'tense-slip', start: w.start, end: w.end, params: { word: w.raw, expected: tense } });
    }
    return out;
}

// ─── Person slips ───────────────────────────────────────────────────

/** First-person singular words (not "mine": a mine is a pit). */
const FIRST_PERSON = set('i me my myself');

/**
 * A first-person word in the narration of a THIRD-person sheet. Only third
 * person is checked: in first- or second-person narration every other person
 * is normal ("I saw her", "you see it"). Speech and italic runs are never read;
 * a capital "I" right after a capitalised word inside a sentence is a numeral
 * ("Henry I") and stays quiet.
 */
export function personSlips(ctx: RuleContext): FindingDraft[] {
    const person = ctx.sheet.person;
    if (person !== 'third_limited' && person !== 'third_omniscient') return [];
    const out: FindingDraft[] = [];
    const words = ctx.seg.words;
    for (let i = 0; i < words.length; i++) {
        ctx.work.ops++;
        const w = words[i];
        if (w.speech || w.italic || !FIRST_PERSON.has(w.surface)) continue;
        if (w.raw === 'I' && i > 0) {
            const prev = words[i - 1];
            const sentenceStart = ctx.seg.sentences[w.sentence]?.firstWord === prev.index;
            if (prev.sentence === w.sentence && /^\p{Lu}/u.test(prev.raw) && !sentenceStart && w.start - prev.end <= 1) continue;
        }
        out.push({ ruleId: 'person-slip', start: w.start, end: w.end, params: { word: w.raw, expected: person } });
    }
    return out;
}

// ─── Banned words and the author's swaps ────────────────────────────

/** Index of words by surface, for phrase look-ups. */
function bySurface(words: readonly Word[]): Map<string, number[]> {
    const m = new Map<string, number[]>();
    for (const w of words) {
        const l = m.get(w.surface);
        if (l) l.push(w.index);
        else m.set(w.surface, [w.index]);
    }
    return m;
}

/**
 * The style sheet's avoided words and phrases, and its swaps (a swap offers
 * its replacement, in the case of the word it replaces, for the author to
 * accept). Matched as whole words in sequence, case and accents folded; a word
 * carrying a possessive is matched but offered no replacement.
 */
export function bannedWords(ctx: RuleContext): FindingDraft[] {
    const items: Array<{ phrase: string; to: string | null }> = [...ctx.sheet.banned.map((p) => ({ phrase: p, to: null })), ...ctx.sheet.swaps.map((s) => ({ phrase: s.from, to: s.to }))];
    if (items.length === 0) return [];
    const words = ctx.seg.words;
    const index = bySurface(words);
    const out: FindingDraft[] = [];
    for (const item of items) {
        const parts = item.phrase.split(' ').map((p) => foldWord(p));
        for (const i of index.get(parts[0]) ?? []) {
            ctx.work.ops++;
            let ok = true;
            for (let k = 1; k < parts.length; k++) {
                const w = words[i + k];
                if (!w || w.surface !== parts[k] || w.sentence !== words[i].sentence) {
                    ok = false;
                    break;
                }
            }
            if (!ok) continue;
            const first = words[i];
            const last = words[i + parts.length - 1];
            const span = ctx.text.slice(first.start, last.end);
            const plain = !/['’]/.test(last.raw);
            const suggestion = item.to !== null && plain ? { start: first.start, end: last.end, replacement: inCaseOf(span, item.to) } : undefined;
            out.push({ ruleId: 'banned-words', start: first.start, end: last.end, params: item.to !== null ? { word: span, replacement: item.to } : { word: span }, ...(suggestion ? { suggestion } : {}) });
        }
    }
    return out;
}

// ─── Spelling variants ──────────────────────────────────────────────

/** A word spelt in the other variety than the sheet's, with its preferred form offered (case kept). */
export function spellingVariants(ctx: RuleContext): FindingDraft[] {
    const spelling = ctx.sheet.spelling;
    if (!spelling) return [];
    const out: FindingDraft[] = [];
    for (const w of ctx.seg.words) {
        ctx.work.ops++;
        if (/['’]/.test(w.raw)) continue;
        const hit = variantFor(w.raw.toLowerCase(), spelling);
        if (!hit) continue;
        out.push({ ruleId: 'spelling-variant', start: w.start, end: w.end, params: { word: w.raw, preferred: inCaseOf(w.raw, hit.preferred), spelling }, suggestion: { start: w.start, end: w.end, replacement: inCaseOf(w.raw, hit.preferred) } });
    }
    return out;
}

// ─── Punctuation before a speech tag ────────────────────────────────

const CLOSING_MARKS = new Set(['”', '"', '’', "'", '»', '›']);

/**
 * The comma before a speech tag on the wrong side of the closing mark, against
 * the sheet: inside (`"Yes," she said`) flags `"Yes", she said`; outside flags
 * the reverse. Only a comma followed by a lower-case word (a tag) is read, and
 * only with explicit speech marks (dash speech has no closing mark). A note:
 * moving punctuation is the author's edit.
 */
export function dialogueTagPunctuation(ctx: RuleContext, speech: ReadonlyArray<{ start: number; end: number }>): FindingDraft[] {
    const rule = ctx.sheet.tagPunctuation;
    const marks = ctx.sheet.quoteMarks;
    if (!rule || marks === null || marks === 'dash' || marks === 'none') return [];
    const t = ctx.text;
    const out: FindingDraft[] = [];
    const lowerAfter = (i: number) => {
        let j = i;
        while (t[j] === ' ') j++;
        return /^\p{Ll}/u.test(t[j] ?? '');
    };
    for (const r of speech) {
        ctx.work.ops++;
        const close = r.end - 1;
        if (!CLOSING_MARKS.has(t[close]) || close <= r.start) continue;
        if (rule === 'inside' && t[r.end] === ',' && /[\p{L}\p{N}]/u.test(t[close - 1]) && lowerAfter(r.end + 1)) {
            out.push({ ruleId: 'dialogue-tag-punctuation', start: close, end: r.end + 1, params: { expected: 'inside' } });
        } else if (rule === 'outside' && t[close - 1] === ',' && t[r.end] === ' ' && lowerAfter(r.end)) {
            out.push({ ruleId: 'dialogue-tag-punctuation', start: close - 1, end: r.end, params: { expected: 'outside' } });
        }
    }
    return out;
}
