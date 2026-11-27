/**
 * The prose checks' test helpers (Phase 5.2): run the engine over plain text or
 * scene HTML with a sheet, and read its findings back as (rule, text) pairs.
 */
import { runProseChecks, type EngineFinding, type ProseCheckOutput } from '@/lib/prose-checks/engine';
import type { WordBaseline } from '@/lib/prose-checks/rules/types';
import { sceneProseText } from '@/lib/prose-checks/scene-text';
import { compileStyleSheet, EMPTY_STYLE_SHEET, type CompiledStyleSheet } from '@/lib/prose-checks/style-sheet';
import type { FieldValue } from '@/lib/bible/field-values';
import type { ProseRuleId } from '@/lib/prose-checks/vocabulary';

export interface CheckOptions {
    sheet?: Record<string, FieldValue> | null;
    alex?: boolean;
    characters?: Array<{ id: string; name: string }>;
    baseline?: WordBaseline | null;
}

export function sheetOf(fields: Record<string, FieldValue> | null | undefined): CompiledStyleSheet {
    return fields ? compileStyleSheet('sheet-1', fields) : EMPTY_STYLE_SHEET;
}

/** The engine over scene HTML (paragraphs: pass `<p>…</p>`), or plain text when it holds no tag. */
export function check(input: string, opts: CheckOptions = {}): ProseCheckOutput & { text: string } {
    const prose = input.includes('<') ? sceneProseText(input) : { text: input, italics: [] };
    const out = runProseChecks({
        text: prose.text,
        italics: prose.italics,
        sheet: sheetOf(opts.sheet),
        alexEnabled: opts.alex ?? false,
        characters: opts.characters ?? [],
        baseline: opts.baseline ?? null,
        sentenceKey: (rule, sentence) => `${rule}|${sentence}`,
    });
    return { ...out, text: prose.text };
}

/** The text each finding of `rule` covers, in order. */
export function hits(out: ProseCheckOutput & { text: string }, rule: ProseRuleId): string[] {
    return out.findings.filter((f: EngineFinding) => f.ruleId === rule).map((f) => out.text.slice(f.start, f.end));
}
