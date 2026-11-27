/**
 * THE PROMPT-INJECTION CORPUS (Phase 2.H, roadmap items 1 and 9), loaded and
 * checked when the module loads. Original text written for Inkquisitor: each
 * case is a piece of author text (an answer, an element's stored text, an
 * imported note) or a research source (a fetched page, an attached file) that
 * carries an instruction to the model. `injection-suite.ts` runs every case
 * through the product's own steps; the nightly red-team runs them against the
 * real model (`scripts/injection-redteam.ts`). Imported as JSON, so the
 * corpus ships in the build and a report names the bytes it ran.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import corpusJson from './injection-corpus.json';

/**
 * Phase 3.3 (D24) adds the canvas interview's two: RELATION_ANSWER (an answer
 * given in an edge interview, reconciled with the relation's fields in scope
 * and new relations offered) and RELATION_TEXT (a relation field's stored text,
 * which a relation round's questions are worded around). Phase 4.0 adds
 * SOURCE_UPLOAD (a passage of an uploaded draft, read for facts) and 4.1
 * BIBLE_ENTRY (an accepted bible entry, read for facts automatically, D27).
 * Phase 4.2 adds CONTINUITY_FACTS (a fact's statement, shown to the nightly
 * deep continuity check with no author in the loop, D28); BIBLE_ENTRY now also
 * covers the threads the same extraction proposes. Phase 4.3 adds STRESS_TEST
 * (an element's summary, read with the whole canon by the stress test, D29),
 * GAP_HUNT (an element's summary in the gap ranking's book view) and
 * COMPACTION (an earlier round's answer, read by the rounds summary). Phase
 * 4.4 adds QUESTION_ORDER (an element's name in the interview tie-break's
 * near-equal candidates, D30 item 4). Phase 5.1 adds MANUSCRIPT_SCENE (a scene's
 * opening, shown to the research run's fit step when a brief is scoped to its
 * chapter, which may propose a NOTE on it and never its prose, D3). Phase 5.3
 * adds DRAFT_SCENE (a scene's own text, read overnight for draft facts and the
 * threads it plants or pays off with no author in the loop, D35).
 */
export const INJECTION_SURFACES = ['ANSWER', 'ELEMENT_TEXT', 'IMPORTED_NOTE', 'RESEARCH_PAGE', 'ATTACHED_FILE', 'RELATION_ANSWER', 'RELATION_TEXT', 'SOURCE_UPLOAD', 'BIBLE_ENTRY', 'CONTINUITY_FACTS', 'STRESS_TEST', 'GAP_HUNT', 'COMPACTION', 'QUESTION_ORDER', 'MANUSCRIPT_SCENE', 'DRAFT_SCENE'] as const;
export type InjectionSurface = (typeof INJECTION_SURFACES)[number];

export const INJECTION_ATTACKS = [
    'IGNORE_PREVIOUS',
    'PROMPT_DISCLOSURE',
    'SCOPE_ESCAPE',
    'CROSS_BOOK',
    'ROLE_CHANGE',
    'FORGED_FENCE',
    'ENCODED',
    'NON_ENGLISH',
    'INVISIBLE_CHARS',
    'EXFIL',
    'TOOL_USE',
    'FALSE_APPROVAL',
] as const;

const CaseSchema = z
    .object({
        id: z.string().regex(/^rt-\d{2}$/),
        surface: z.enum(INJECTION_SURFACES),
        attack: z.enum(INJECTION_ATTACKS),
        text: z.string().min(10).max(2_000),
    })
    .strict();
export type InjectionCase = z.infer<typeof CaseSchema>;

const CorpusSchema = z
    .object({ format: z.literal('inkquisitor-injection-corpus/1'), cases: z.array(CaseSchema).min(1).max(200) })
    .strict()
    .superRefine((c, ctx) => {
        const ids = new Set<string>();
        for (const x of c.cases) {
            if (ids.has(x.id)) ctx.addIssue({ code: 'custom', message: `duplicate case ${x.id}` });
            ids.add(x.id);
        }
    });

const parsed = CorpusSchema.parse(corpusJson);

export const INJECTION_CORPUS: { readonly cases: readonly InjectionCase[]; readonly hash: string } = Object.freeze({
    cases: Object.freeze(parsed.cases.map((c) => Object.freeze({ ...c }))),
    hash: `sha256:${createHash('sha256').update(JSON.stringify(corpusJson)).digest('hex')}`,
});
