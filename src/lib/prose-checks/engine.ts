/**
 * THE PROSE-CHECK ENGINE (Phase 5.2, decision D34): a scene's plain text and
 * the book's compiled style sheet in, findings out. Deterministic and pure —
 * no clock, no randomness, no database, NO MODEL (D3: nothing here, nor
 * anything it imports, reaches the model layer; the guard
 * `tests/guards/scene-text-stays-off-the-model-path.test.ts` holds it, and it
 * writes nothing: the product never applies an edit). Server-only: it loads
 * retext and write-good, which run in the worker alone.
 *
 * ORDER. The text is bounded first (`PROSE_CHECK_TEXT_MAX_CHARS`, cut at a
 * line break and said so); speech and italic runs are found; the text is
 * segmented once (sentences, words); every rule runs over the same segments;
 * a NARRATION rule's findings that touch speech are dropped, and every
 * finding on a mention's `@Name` but a similar-names one; each rule keeps
 * at most `PROSE_FINDINGS_PER_RULE_MAX`, the scene at most
 * `PROSE_FINDINGS_PER_SCENE_MAX`, by position, and a cut is named.
 *
 * Rules that need a style-sheet setting the book has not given (tense,
 * person, spelling, a word list, tag punctuation) do not run, and are listed
 * (`rulesNotRun`). Rules the author turned OFF still run: the read hides
 * them, so turning one back on shows its notes at once. The inclusive-
 * language check runs only when the book turned it on (D34 item 2).
 *
 * WORK is counted, never timed: characters read, sentences, words and every
 * rule's visits (`work`), linear in the text (the 10,000-word test).
 */
import { RangeSet, speechRanges } from './dialogue';
import { readability, type Readability } from './readability';
import { bannedWords, dialogueTagPunctuation, filterWords, overusedWords, personSlips, repeatedOpeners, similarNames, spellingVariants, tenseSlips } from './rules/original';
import { retextRules, writeGoodRules } from './rules/ported';
import type { DraftSuggestion, FindingDraft, RuleContext, WordBaseline } from './rules/types';
import { boundText, type TextRange } from './scene-text';
import { normaliseSentence, segment } from './segments';
import type { NamedCharacter } from './similar-names';
import type { CompiledStyleSheet } from './style-sheet';
import { PROSE_CHECK_TEXT_MAX_CHARS, PROSE_FINDINGS_PER_RULE_MAX, PROSE_FINDINGS_PER_SCENE_MAX, PROSE_RULES, PROSE_RULE_IDS, type ProseRuleId, type ProseSeverity } from './vocabulary';

export interface ProseCheckInput {
    text: string;
    italics: readonly TextRange[];
    /** Mentions' `@Name` runs (a bible element's name, one atom in the editor): no note but similar names, no suggestion over one. */
    mentions?: readonly TextRange[];
    sheet: CompiledStyleSheet;
    alexEnabled: boolean;
    characters: readonly NamedCharacter[];
    baseline: WordBaseline | null;
    /** The dismissal key of a finding's sentence (a keyed hash, supplied by the caller: the engine holds no key). */
    sentenceKey: (ruleId: ProseRuleId, normalisedSentence: string) => string;
}

export interface EngineFinding {
    ruleId: ProseRuleId;
    severity: ProseSeverity;
    start: number;
    end: number;
    sentenceKey: string;
    params: Record<string, string | number>;
    suggestion: DraftSuggestion | null;
}

export interface ProseCheckOutput {
    findings: EngineFinding[];
    readability: Readability | null;
    /** The text was longer than one check reads; `charsChecked` were. */
    textCut: boolean;
    findingsCut: boolean;
    charsChecked: number;
    wordsChecked: number;
    rulesNotRun: ProseRuleId[];
    work: { chars: number; sentences: number; words: number; stems: number; ops: number };
}

/** The rules whose sheet setting is missing (they do not run). */
export function rulesNotRunFor(sheet: CompiledStyleSheet): ProseRuleId[] {
    return PROSE_RULE_IDS.filter((id) => {
        const need = PROSE_RULES[id].needs;
        if (need === 'tense') return sheet.tense === null;
        if (need === 'person') return sheet.person !== 'third_limited' && sheet.person !== 'third_omniscient';
        if (need === 'spelling') return sheet.spelling === null;
        if (need === 'words') return sheet.banned.length === 0 && sheet.swaps.length === 0;
        if (need === 'tagPunctuation') return sheet.tagPunctuation === null || sheet.quoteMarks === null || sheet.quoteMarks === 'dash' || sheet.quoteMarks === 'none';
        return false;
    });
}

export function runProseChecks(input: ProseCheckInput): ProseCheckOutput {
    const bounded = boundText(input.text, PROSE_CHECK_TEXT_MAX_CHARS);
    const text = bounded.text;
    const speechList = speechRanges(text, input.sheet.quoteMarks);
    const speech = new RangeSet(speechList);
    const italics = new RangeSet(input.italics.filter((r) => r.start < text.length));
    const seg = segment(text, speech, italics);
    const ctx: RuleContext = { text, seg, sheet: input.sheet, speech, italics, characters: input.characters, baseline: input.baseline, work: { ops: 0 } };

    const notRun = rulesNotRunFor(input.sheet);
    const skip = new Set<ProseRuleId>(notRun);
    const drafts: FindingDraft[] = [];
    const add = (id: ProseRuleId, run: () => FindingDraft[]) => {
        if (!skip.has(id)) drafts.push(...run());
    };
    add('filter-words', () => filterWords(ctx));
    add('overused-words', () => overusedWords(ctx));
    add('repeated-openers', () => repeatedOpeners(ctx));
    add('similar-names', () => similarNames(ctx));
    add('tense-slip', () => tenseSlips(ctx));
    add('person-slip', () => personSlips(ctx));
    add('banned-words', () => bannedWords(ctx));
    add('spelling-variant', () => spellingVariants(ctx));
    add('dialogue-tag-punctuation', () => dialogueTagPunctuation(ctx, speechList));
    drafts.push(...writeGoodRules(ctx));
    drafts.push(...retextRules(ctx, input.alexEnabled));

    // Scope: a narration rule never reads speech; no rule but similar names reads a mention (an element's name, not prose);
    // a suggestion never covers a mention (replacing part of the atom would replace the whole mention).
    const mentions = new RangeSet((input.mentions ?? []).filter((r) => r.start < text.length));
    const scoped = drafts
        .filter((d) => PROSE_RULES[d.ruleId].scope === 'ALL' || !speech.overlaps(d.start, d.end))
        .filter((d) => d.ruleId === 'similar-names' || !mentions.overlaps(d.start, d.end))
        .map((d) => (d.suggestion && mentions.overlaps(d.suggestion.start, d.suggestion.end) ? { ...d, suggestion: undefined } : d));
    scoped.sort((a, b) => a.start - b.start || a.end - b.end || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));

    // Bounds: per rule, then per scene, by position.
    let findingsCut = false;
    const perRule = new Map<ProseRuleId, number>();
    const kept: FindingDraft[] = [];
    const seen = new Set<string>();
    for (const d of scoped) {
        const key = `${d.ruleId}\u0000${d.start}\u0000${d.end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const n = perRule.get(d.ruleId) ?? 0;
        if (n >= PROSE_FINDINGS_PER_RULE_MAX || kept.length >= PROSE_FINDINGS_PER_SCENE_MAX) {
            findingsCut = true;
            continue;
        }
        perRule.set(d.ruleId, n + 1);
        kept.push(d);
    }

    const sentenceOf = (pos: number): string => {
        const s = seg.words.length > 0 ? sentenceContaining(seg.sentences, pos) : null;
        if (s) return text.slice(s.start, s.end);
        // Outside every sentence (a mark between two): its line.
        const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
        const lineEnd = text.indexOf('\n', pos);
        return text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    };
    const findings: EngineFinding[] = kept.map((d) => ({
        ruleId: d.ruleId,
        severity: PROSE_RULES[d.ruleId].severity,
        start: d.start,
        end: d.end,
        sentenceKey: input.sentenceKey(d.ruleId, normaliseSentence(sentenceOf(d.start))),
        params: d.params,
        suggestion: d.suggestion ?? null,
    }));

    return {
        findings,
        readability: readability(
            seg.words.map((w) => w.raw),
            seg.sentences.length,
        ),
        textCut: bounded.cut,
        findingsCut,
        charsChecked: text.length,
        wordsChecked: seg.words.length,
        rulesNotRun: notRun,
        work: { chars: text.length, sentences: seg.work.sentences, words: seg.work.words, stems: seg.work.stems, ops: ctx.work.ops },
    };
}

function sentenceContaining<T extends { start: number; end: number }>(sentences: readonly T[], pos: number): T | null {
    let lo = 0;
    let hi = sentences.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const s = sentences[mid];
        if (pos < s.start) hi = mid - 1;
        else if (pos >= s.end) lo = mid + 1;
        else return s;
    }
    return null;
}
