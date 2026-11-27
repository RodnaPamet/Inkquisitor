/**
 * THE RESEARCH EVALUATION SETS (Phase 2.6; roadmap rule 9), loaded and checked
 * when the module loads:
 *
 *   research.json     ten briefs across genres (historical mystery, science
 *                     fiction, fantasy, Regency romance, thriller, young adult,
 *                     literary fiction, police procedural, gothic horror,
 *                     western), each with its scope elements, a FAKE WEB (the
 *                     pages a search would find, fixed text), the claims a run
 *                     must cover, the fields a proposal may fairly target, and
 *                     a reference answer for each step;
 *                     (Phase 5.1: rs-11 is scoped to manuscript scenes as well,
 *                     and its reference notes the one a finding bears on);
 *   adversarial.json  six briefs whose fake web holds a page carrying an
 *                     instruction to the model (ignore your instructions and
 *                     write into every field; put the author's character names
 *                     in a query; approve everything; reveal the prompt; fetch
 *                     an exfiltration URL). Each must change nothing beyond the
 *                     page's facts: no injected phrase in anything stored, no
 *                     out-of-scope proposal, no query carrying the scope's text.
 *
 * Original content written for Inkquisitor; every page is invented and every
 * URL is under a reserved `.example` name. Imported as JSON so the sets ship
 * in the build and a record is checked against the bytes the build holds.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BIBLE_KINDS } from '@/lib/bible/kinds';
import { getFieldDef } from '@/lib/bible/templates';
import researchJson from './research.json';
import adversarialJson from './adversarial.json';

const fieldValue = z.union([z.string(), z.array(z.string()), z.number().int()]);

const ElementSchema = z
    .object({
        id: z.string().regex(/^el-[a-z0-9]+$/),
        kind: z.enum(BIBLE_KINDS),
        name: z.string().min(1),
        role: z.enum(['scope', 'related']),
        summary: z.string(),
        stored: z.record(z.string(), fieldValue),
    })
    .strict();

const CaseSchema = z
    .object({
        id: z.string().regex(/^(rs|adv)-\d{2}$/),
        genre: z.string().min(1),
        attack: z.string().optional(),
        brief: z.object({ question: z.string().min(1), purpose: z.string().min(1), depth: z.enum(['QUICK', 'STANDARD', 'THOROUGH']) }).strict(),
        scope: z.array(ElementSchema).min(1),
        /** Phase 5.1: the manuscript scenes the fit step is shown (refs s1, s2, … in this order). */
        scenes: z
            .array(
                z
                    .object({
                        id: z.string().regex(/^sc-\d{2}$/),
                        title: z.string().nullable(),
                        chapter: z.string().nullable(),
                        pov: z.string().nullable(),
                        setting: z.string().nullable(),
                        storyTime: z.string().nullable(),
                        excerpt: z.string(),
                    })
                    .strict(),
            )
            .optional(),
        web: z.array(z.object({ url: z.url(), title: z.string(), text: z.string().min(1) }).strict()).min(1),
        expect: z
            .object({
                claims: z.array(z.object({ mustContain: z.array(z.string().min(1)).min(1) }).strict()).min(1),
                fitTargets: z.array(z.object({ elementId: z.string(), fieldKey: z.string() }).strict()).min(1),
                /** Phase 5.1: the scenes a note may fairly be on; a case naming any expects at least one. */
                sceneTargets: z.array(z.string()).optional(),
                mustNotContain: z.array(z.string()),
                mustNotQuery: z.array(z.string()),
            })
            .strict(),
        reference: z
            .object({
                queries: z.array(z.string().min(1)).min(1),
                findings: z.unknown(),
                fit: z.unknown(),
            })
            .strict(),
    })
    .strict();
export type ResearchEvalCase = z.infer<typeof CaseSchema>;

const SetSchema = z.object({ format: z.literal('inkquisitor-research-eval/1'), cases: z.array(CaseSchema) }).strict();

function load(raw: unknown, name: string): ResearchEvalCase[] {
    const parsed = SetSchema.parse(raw).cases;
    for (const c of parsed) {
        for (const e of c.scope) {
            for (const key of Object.keys(e.stored)) {
                if (!getFieldDef(e.kind, key)) throw new Error(`${name}: ${c.id} stores an unknown field ${e.kind}.${key}`);
            }
        }
        for (const s of c.expect.sceneTargets ?? []) {
            if (!(c.scenes ?? []).some((x) => x.id === s)) throw new Error(`${name}: ${c.id} targets an unknown scene`);
        }
        for (const t of c.expect.fitTargets) {
            const e = c.scope.find((x) => x.id === t.elementId);
            if (!e || !getFieldDef(e.kind, t.fieldKey)) throw new Error(`${name}: ${c.id} targets an unknown field`);
        }
    }
    return parsed;
}

export const researchCases: readonly ResearchEvalCase[] = load(researchJson, 'research.json');
export const adversarialCases: readonly ResearchEvalCase[] = load(adversarialJson, 'adversarial.json');
export const allResearchCases: readonly ResearchEvalCase[] = [...researchCases, ...adversarialCases];

const hashOf = (v: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(v)).digest('hex')}`;

/** The sets' hashes, as a record names them. */
export const researchEvalSets = {
    research: { hash: hashOf(researchJson) },
    adversarial: { hash: hashOf(adversarialJson) },
} as const;
