/**
 * DOES A MODEL'S ANSWER DISCLOSE ITS INSTRUCTIONS? (Phase 2.H, roadmap item
 * 1: "no system-prompt disclosure".)
 *
 * The evaluation graders counted DISCLOSES_INSTRUCTIONS (six consecutive words
 * of the system prompt in a stored text) but nothing in the product refused
 * it, so a model an injection talked into reciting its instructions had them
 * shown to the author or stored in the bible's proposals. Each validator now
 * asks this of every text it would show or store, against its own prompt's
 * static system and task text: eight consecutive words in common, or any
 * spelling of the fence's tag (`author_data`, which no answer has a reason to
 * carry), refuse the item. EIGHT, where the graders count six: a recitation
 * runs long, and the prompts describe what an answer should say ("a short
 * rationale: how the finding bears on this entry"), so a faithful answer can
 * echo six of their words and must not be refused for it.
 */
import { FENCE_TAG_STEM } from '@/lib/ai/prompt';
import { normaliseText, words } from '@/lib/interview/text';

/** Consecutive words a text must share with a prompt to disclose it (the evaluation graders count six). */
export const DISCLOSURE_RUN_WORDS = 8;

function runsOf(text: string): Set<string> {
    const w = words(normaliseText(text));
    const out = new Set<string>();
    for (let i = 0; i + DISCLOSURE_RUN_WORDS <= w.length; i++) out.add(w.slice(i, i + DISCLOSURE_RUN_WORDS).join(' '));
    return out;
}

/** The word runs of these prompts' static text, built once per caller. */
export function promptRuns(prompts: ReadonlyArray<{ readonly system: string; readonly task: string }>): ReadonlySet<string> {
    return new Set(prompts.flatMap((p) => [...runsOf(p.system), ...runsOf(p.task)]));
}

/** True when any of `texts` shares a six-word run with `runs`, or spells the fence's tag. */
export function disclosesInstructions(texts: ReadonlyArray<string | null | undefined>, runs: ReadonlySet<string>): boolean {
    for (const text of texts) {
        if (!text) continue;
        const folded = normaliseText(text).replace(/[\s_-]+/g, '_');
        if (folded.includes(FENCE_TAG_STEM)) return true;
        for (const run of runsOf(text)) if (runs.has(run)) return true;
    }
    return false;
}
