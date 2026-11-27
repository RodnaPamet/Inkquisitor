/**
 * What a rule is handed and what it returns (Phase 5.2, D34). Pure types.
 */
import type { NamedCharacter } from '../similar-names';
import type { CompiledStyleSheet } from '../style-sheet';
import type { RangeSet } from '../dialogue';
import type { Segmented } from '../segments';
import type { ProseRuleId } from '../vocabulary';

/** The book's word frequencies (the overused-words baseline): stem counts of its most frequent content words. */
export interface WordBaseline {
    /** Words the baseline read in all. */
    totalWords: number;
    /** Stem → count, for at most `PROSE_BASELINE_STEMS_MAX` stems. */
    counts: Readonly<Record<string, number>>;
    /** The smallest count kept (a stem missing from `counts` occurs at most this often); 0 when every stem was kept. */
    minKept: number;
}

export interface RuleContext {
    text: string;
    seg: Segmented;
    sheet: CompiledStyleSheet;
    speech: RangeSet;
    italics: RangeSet;
    characters: readonly NamedCharacter[];
    baseline: WordBaseline | null;
    /** Counted work: each rule adds what it visits (the engine's work bound is held by this, never by a clock). */
    work: { ops: number };
}

export interface DraftSuggestion {
    start: number;
    end: number;
    replacement: string;
}

export interface FindingDraft {
    ruleId: ProseRuleId;
    start: number;
    end: number;
    params: Record<string, string | number>;
    suggestion?: DraftSuggestion;
}
