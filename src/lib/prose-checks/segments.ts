/**
 * A scene's plain text cut into what the rules read (Phase 5.2, D34): lines,
 * sentences and words, every one with its offsets into the text. Pure.
 *
 * SENTENCES come from `Intl.Segmenter` (granularity `sentence`, the Unicode
 * sentence rules) one LINE at a time, so no sentence ever spans two
 * paragraphs. WORDS come from 3.4's analyser (`createAnalyzer`, the Unicode
 * word rules, apostrophes unified, folded surface and Porter2 stem), so a word
 * here is the same word word search finds. A word knows its sentence and
 * whether it sits in speech or in an italic run (`dialogue.ts`).
 */
import { createAnalyzer, foldText, type Analyzer } from '@/lib/search/analyse';
import type { RangeSet } from './dialogue';

export interface Sentence {
    index: number;
    start: number;
    end: number;
    line: number;
    /** Its first word's index into `words` (-1: no word). */
    firstWord: number;
    /** One past its last word's index. */
    endWord: number;
}

export interface Word {
    index: number;
    start: number;
    end: number;
    /** As written. */
    raw: string;
    /** Folded (lower case, diacritics, apostrophes, possessive). */
    surface: string;
    stem: string;
    sentence: number;
    speech: boolean;
    italic: boolean;
}

export interface Segmented {
    text: string;
    sentences: Sentence[];
    words: Word[];
    /** Counted work: sentences cut, words segmented, stems computed. */
    work: { sentences: number; words: number; stems: number };
}

export function segment(text: string, speech: RangeSet, italics: RangeSet, analyzer: Analyzer = createAnalyzer('en')): Segmented {
    const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    const sentences: Sentence[] = [];
    let base = 0;
    let lineNo = 0;
    for (const line of text.split('\n')) {
        for (const seg of sentenceSegmenter.segment(line)) {
            const trimmed = seg.segment.trimEnd();
            if (trimmed.trim() === '') continue;
            const lead = trimmed.length - trimmed.trimStart().length;
            sentences.push({ index: sentences.length, start: base + seg.index + lead, end: base + seg.index + trimmed.length, line: lineNo, firstWord: -1, endWord: -1 });
        }
        base += line.length + 1;
        lineNo++;
    }
    const tokens = analyzer.tokenise(text);
    const words: Word[] = [];
    let s = 0;
    for (const t of tokens) {
        while (s < sentences.length && sentences[s].end <= t.start) s++;
        const sentence = s < sentences.length && sentences[s].start <= t.start ? s : Math.max(0, s - 1);
        const w: Word = {
            index: words.length,
            start: t.start,
            end: t.end,
            raw: text.slice(t.start, t.end),
            surface: t.surface,
            stem: t.stem,
            sentence,
            speech: speech.overlaps(t.start, t.end),
            italic: italics.overlaps(t.start, t.end),
        };
        words.push(w);
        const st = sentences[sentence];
        if (st) {
            if (st.firstWord === -1) st.firstWord = w.index;
            st.endWord = w.index + 1;
        }
    }
    return { text, sentences, words, work: { sentences: sentences.length, words: words.length, stems: analyzer.stemsComputed } };
}

/** A sentence's text normalised for its dismissal key: folded, its spaces one space, trimmed. */
export function normaliseSentence(text: string): string {
    return foldText(text).replace(/\s+/g, ' ').trim();
}
