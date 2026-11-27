/**
 * The prose checks' vocabulary (Phase 5.2, decision D34): the rules, their
 * scope and severity, the bounds, the statuses a scene's check reads as, and
 * the readability bands. CLIENT-SAFE: no Node module, no rule code — the
 * editor's margin and the settings section read it to word what the worker
 * stored. The rules themselves (and retext, write-good and alex's plugins)
 * load only in the worker (`./engine.ts`), never in a browser bundle.
 *
 * SCOPE. A NARRATION rule never reads speech: what a character says is their
 * voice, and a tense, person, filter-word or inclusive-language note on it
 * would be noise. Speech is found by the dialogue detector (`./dialogue.ts`),
 * from the style sheet's speech marks; the TENSE and PERSON checks also skip
 * italic runs (thought and emphasis). An ALL rule reads everything.
 */

export const PROSE_RULE_IDS = [
    'filter-words',
    'overused-words',
    'repeated-openers',
    'similar-names',
    'tense-slip',
    'person-slip',
    'banned-words',
    'spelling-variant',
    'dialogue-tag-punctuation',
    'intensifiers',
    'wordy',
    'cliches',
    'repeated-words',
    'inclusive-language',
] as const;

export type ProseRuleId = (typeof PROSE_RULE_IDS)[number];

export function isProseRuleId(value: unknown): value is ProseRuleId {
    return typeof value === 'string' && (PROSE_RULE_IDS as readonly string[]).includes(value);
}

export type ProseRuleScope = 'NARRATION' | 'ALL';
export type ProseSeverity = 'NOTE' | 'WARNING';
/** Where a rule comes from: our own code, or a ported MIT package (credited in NOTICE). */
export type ProseRuleSource = 'ORIGINAL' | 'RETEXT' | 'WRITE_GOOD' | 'ALEX';
/** The style sheet setting a rule needs before it can run (null: none). */
export type ProseSheetNeed = 'tense' | 'person' | 'spelling' | 'words' | 'tagPunctuation' | null;

export interface ProseRuleMeta {
    id: ProseRuleId;
    scope: ProseRuleScope;
    severity: ProseSeverity;
    source: ProseRuleSource;
    needs: ProseSheetNeed;
    /** Off by default (only the inclusive-language check, D34: the author turns it on per book). */
    defaultOff?: true;
    /** It may offer a deterministic replacement the author can accept (D34 item 4). */
    suggests?: true;
}

export const PROSE_RULES: Readonly<Record<ProseRuleId, ProseRuleMeta>> = {
    'filter-words': { id: 'filter-words', scope: 'NARRATION', severity: 'NOTE', source: 'ORIGINAL', needs: null },
    'overused-words': { id: 'overused-words', scope: 'NARRATION', severity: 'NOTE', source: 'ORIGINAL', needs: null },
    'repeated-openers': { id: 'repeated-openers', scope: 'NARRATION', severity: 'NOTE', source: 'ORIGINAL', needs: null },
    'similar-names': { id: 'similar-names', scope: 'ALL', severity: 'NOTE', source: 'ORIGINAL', needs: null },
    'tense-slip': { id: 'tense-slip', scope: 'NARRATION', severity: 'WARNING', source: 'ORIGINAL', needs: 'tense' },
    'person-slip': { id: 'person-slip', scope: 'NARRATION', severity: 'WARNING', source: 'ORIGINAL', needs: 'person' },
    'banned-words': { id: 'banned-words', scope: 'ALL', severity: 'WARNING', source: 'ORIGINAL', needs: 'words', suggests: true },
    'spelling-variant': { id: 'spelling-variant', scope: 'ALL', severity: 'WARNING', source: 'ORIGINAL', needs: 'spelling', suggests: true },
    'dialogue-tag-punctuation': { id: 'dialogue-tag-punctuation', scope: 'ALL', severity: 'NOTE', source: 'ORIGINAL', needs: 'tagPunctuation' },
    intensifiers: { id: 'intensifiers', scope: 'NARRATION', severity: 'NOTE', source: 'WRITE_GOOD', needs: null, suggests: true },
    wordy: { id: 'wordy', scope: 'NARRATION', severity: 'NOTE', source: 'WRITE_GOOD', needs: null },
    cliches: { id: 'cliches', scope: 'NARRATION', severity: 'NOTE', source: 'WRITE_GOOD', needs: null },
    'repeated-words': { id: 'repeated-words', scope: 'ALL', severity: 'WARNING', source: 'RETEXT', needs: null, suggests: true },
    'inclusive-language': { id: 'inclusive-language', scope: 'NARRATION', severity: 'NOTE', source: 'ALEX', needs: null, defaultOff: true },
};

/** The rules an author may turn off for a book (every rule but the inclusive-language check, which has its own switch). */
export const TOGGLEABLE_RULE_IDS: readonly ProseRuleId[] = PROSE_RULE_IDS.filter((id) => PROSE_RULES[id].defaultOff !== true);

// ─── Bounds ─────────────────────────────────────────────────────────

/** Characters of a scene's plain text one check reads at most (about 20,000 words); a longer scene is checked up to a line break before it and says so. */
export const PROSE_CHECK_TEXT_MAX_CHARS = 120_000;
/** Findings a scene stores at most (sorted by position); past it the check says it was cut. */
export const PROSE_FINDINGS_PER_SCENE_MAX = 400;
/** Findings one rule contributes to a scene at most (the first, by position). */
export const PROSE_FINDINGS_PER_RULE_MAX = 60;
/** The debounce: a scene's check runs this long after its last save (D34 item 1: a few seconds after the author stops). */
export const PROSE_CHECK_DEBOUNCE_MS = 4_000;
/** Scenes a chapter's re-run queues at most (a chapter holding more is answered with the count it left). */
export const PROSE_CHAPTER_RERUN_MAX = 200;
/** Character names a check compares at most (the book's oldest). */
export const PROSE_CHARACTER_NAMES_MAX = 500;
/** Characters of the whole manuscript the overused-words baseline reads at most. */
export const PROSE_BASELINE_TEXT_MAX_CHARS = 2_000_000;
/** A baseline older than this is recomputed by the next check that needs it. */
export const PROSE_BASELINE_MAX_AGE_MS = 30 * 60_000;
/** Words the baseline keeps counts of (the most frequent stems). */
export const PROSE_BASELINE_STEMS_MAX = 4_000;
/** Dismissals a book holds at most (the oldest go first past it). */
export const PROSE_DISMISSALS_PER_BOOK_MAX = 5_000;
/** The words a style sheet's word list items may hold to be checkable (a longer item is a construction, not a word). */
export const STYLE_WORD_ITEM_MAX_WORDS = 4;

/** Increment when any rule's behaviour changes; `tests/unit/prose-checks/rules-version.test.ts` pins it to the rule files' hash. */
export const PROSE_RULES_VERSION = 1;

// ─── Statuses ───────────────────────────────────────────────────────

/**
 * What a scene's check reads as (rule 6: zero is never complete):
 *   NOT_CHECKED  no check has run: never "no notes"
 *   PENDING      the text changed since the check (a newer save is queued)
 *   OUTDATED     the style sheet, the inclusive-language switch or the rules changed since it ran
 *   CHECKED      the stored text was checked under the current sheet and rules
 */
export const PROSE_CHECK_STATUSES = ['NOT_CHECKED', 'PENDING', 'OUTDATED', 'CHECKED'] as const;
export type ProseCheckStatus = (typeof PROSE_CHECK_STATUSES)[number];

// ─── Readability ────────────────────────────────────────────────────

/** Words a scene needs before its readability is reported (fewer reads "not assessed"). */
export const READABILITY_MIN_WORDS = 100;

export const READABILITY_BANDS = ['very_easy', 'easy', 'plain', 'fairly_hard', 'hard', 'very_hard'] as const;
export type ReadabilityBand = (typeof READABILITY_BANDS)[number];

/** The band of a reading-ease score (higher is easier). A band describes, never judges: a dense literary scene may be meant to be hard. */
export function readabilityBand(ease: number): ReadabilityBand {
    if (ease >= 90) return 'very_easy';
    if (ease >= 75) return 'easy';
    if (ease >= 60) return 'plain';
    if (ease >= 45) return 'fairly_hard';
    if (ease >= 30) return 'hard';
    return 'very_hard';
}

// ─── Style sheet values (the STYLE template's structured fields) ────

export const STYLE_SPELLINGS = ['british', 'american', 'canadian', 'australian'] as const;
export type StyleSpelling = (typeof STYLE_SPELLINGS)[number];
export const STYLE_TENSES = ['past', 'present'] as const;
export type StyleTense = (typeof STYLE_TENSES)[number];
export const STYLE_PERSONS = ['first', 'second', 'third_limited', 'third_omniscient'] as const;
export type StylePerson = (typeof STYLE_PERSONS)[number];
export const STYLE_QUOTE_MARKS = ['double', 'single', 'guillemets', 'dash', 'none'] as const;
export type StyleQuoteMarks = (typeof STYLE_QUOTE_MARKS)[number];
export const STYLE_TAG_PUNCTUATION = ['inside', 'outside'] as const;
export type StyleTagPunctuation = (typeof STYLE_TAG_PUNCTUATION)[number];

/** The refusal codes of the prose-check routes (`details.reason`), worded by `manuscript.proseChecks.reasons`. */
export const PROSE_CHECK_REASONS = ['FINDING_GONE', 'UNKNOWN_RULE'] as const;
export type ProseCheckReason = (typeof PROSE_CHECK_REASONS)[number];

// ─── The wire (types only) ──────────────────────────────────────────

export interface ProseSuggestionView {
    /** Offsets into the scene's plain text this replacement covers (may differ from the finding's own range: a deletion takes its space too). */
    start: number;
    end: number;
    /** '' deletes. */
    replacement: string;
    /** The text at that range when the check ran: the editor draws (and lets the author accept) the suggestion only where its own text still reads this. */
    matched: string;
}

export interface ProseFindingView {
    id: string;
    ruleId: ProseRuleId;
    severity: ProseSeverity;
    /** Offsets into the scene's plain text (`HtmlTextReader`, lines joined by `\n`). */
    start: number;
    end: number;
    /** The text at that range when the check ran: the editor places a note only where its own text still reads this. */
    matched: string;
    /** Message parameters (words of the scene or the style sheet: author text, shown only to the author's workspace). */
    params: Record<string, string | number>;
    suggestion: ProseSuggestionView | null;
}

export interface ProseReadabilityView {
    words: number;
    sentences: number;
    readingEase: number;
    gradeLevel: number;
    band: ReadabilityBand;
}

export interface SceneProseChecksView {
    sceneId: string;
    status: ProseCheckStatus;
    /** The scene revision the stored check read (null: never checked). */
    checkedRevision: number | null;
    /** The text was longer than one check reads: only its first part was checked. */
    textCut: boolean;
    /** More findings than a scene stores, or than a rule contributes: the rest were not kept. */
    findingsCut: boolean;
    wordsChecked: number;
    readability: ProseReadabilityView | null;
    /** The style sheet the check read, or null (no whole-book STYLE element): rules that need it did not run. */
    styleSheetElementId: string | null;
    /** Rules that could not run for want of a style sheet setting. */
    rulesNotRun: ProseRuleId[];
    /** Findings shown (rules turned off and dismissed sentences left out). */
    findings: ProseFindingView[];
    /** How many were left out as dismissed. */
    dismissed: number;
    /** How many were left out because their rule is off for the book. */
    hiddenByRule: number;
}

export interface ProseCheckSettingsView {
    alexEnabled: boolean;
    rulesOff: ProseRuleId[];
    dismissals: number;
    styleSheet: { elementId: string; name: string } | null;
    similarNames: Array<{ a: { id: string; name: string }; b: { id: string; name: string }; why: SimilarNameReason }>;
    similarNamesCut: boolean;
}

export type SimilarNameReason = 'SAME_FIRST_NAME' | 'ONE_LETTER' | 'SAME_SHAPE' | 'SOUNDS_ALIKE';
