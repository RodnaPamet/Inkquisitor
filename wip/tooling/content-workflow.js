export const meta = {
  name: 'inkquisitor-content',
  description: 'Write the Phase 1-2 content for Inkquisitor in a staging folder: bible templates, interviewer packs, evaluation sets, and a judged question-engine design',
  phases: [
    { title: 'Format', detail: 'define the file formats every other agent follows' },
    { title: 'Templates', detail: 'one bible field template per element kind' },
    { title: 'Packs', detail: 'craft pack per kind and six personas, each licence-reviewed' },
    { title: 'Evals', detail: 'evaluation sets for question generation and enrichment' },
    { title: 'Design', detail: 'three independent question-engine designs, judged and synthesized' },
    { title: 'Consistency', detail: 'cross-check every key and reference' },
  ],
}

const ROOT = '/home/user/ink-staging'
const BASE = `You are writing content for Inkquisitor, a SaaS that takes an author from a book concept to publishing readiness by reverse prompting: the product asks the author questions, the author answers, and the answers are folded into a structured "bible" per book element (after the author accepts each change). Read /home/user/Inkquisitor/docs/ROADMAP.md (sections 1-4, especially Phase 1.1, 2.2, 2.3 and 2.5) before you start.

Write ONLY under ${ROOT}. Do not touch /home/user/Inkquisitor or /home/user/inflect-compliance (read them only). Do not use git.

Licence and originality rules (binding):
- Every question, label, description and instruction you write is ORIGINAL text in neutral craft vocabulary.
- Do not use trademarked or branded framework names or their beat labels as labels (Save the Cat, Story Grid, Dramatica, Snowflake Method, Hero's Journey stage names, Truby's steps). Public-domain ideas (three acts, rising action, climax, Freytag) are fine.
- Do not copy text from GPL/AGPL projects (bibisco, Manuskript, novelWriter, SillyTavern) or from craft books. You may draw on general craft knowledge. MIT projects such as danjdewhurst/story-skills and mattpocock/skills may be used for ideas; do not paste their text either.
- The AI never writes manuscript prose (owner decision D3). Packs instruct the interviewer to ask, summarise the author's own answers, and challenge; never to propose story content as if it were the author's.

Element kinds (closed list): PREMISE, PLOT, CHARACTER, SETTING, THEME, MOOD, TEXTURE, STYLE, POV, WORLD_RULE, TIMELINE_EVENT, FACTION, OBJECT, RESEARCH, CUSTOM.`

const KINDS = ['PREMISE', 'PLOT', 'CHARACTER', 'SETTING', 'THEME', 'MOOD', 'TEXTURE', 'STYLE', 'POV', 'WORLD_RULE', 'TIMELINE_EVENT', 'FACTION', 'OBJECT', 'RESEARCH']
const PERSONAS = [
  { key: 'gentle-mentor', name: 'Gentle Mentor', gist: 'warm, encouraging, builds confidence, still gets to specifics' },
  { key: 'ruthless-editor', name: 'Ruthless Editor', gist: 'blunt, cuts vagueness, demands stakes and consequences, never cruel' },
  { key: 'socratic', name: 'Socratic', gist: 'asks only questions that lead the author to examine their own assumptions' },
  { key: 'devils-advocate', name: "Devil's Advocate", gist: 'argues the opposite of each choice to test whether it holds' },
  { key: 'target-reader', name: 'Target Reader', gist: 'asks what a reader of this genre and audience would want, fear and notice' },
  { key: 'genre-specialist', name: 'Genre Specialist', gist: 'asks about the genre promises, conventions and where the book departs from them' },
]

const DONE = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }, required: ['files'] }
const REVIEW = {
  type: 'object',
  properties: {
    problems: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } }, required: ['file', 'problem', 'fix'] } },
  },
  required: ['problems'],
}

phase('Format')
await agent(`${BASE}

Write ${ROOT}/FORMAT.md defining the exact file formats that the other content agents will follow, and nothing else. Define:
1. Bible template file: ${ROOT}/templates/<kind>.json — JSON with kind, label, description, fields (array of {key (snake_case, unique within the kind), label, help (one sentence telling the author what belongs there), type ("text" | "richtext" | "list" | "choice" | "scale"), options (for choice), required (boolean: needed for the kind to count as complete), order, dependsOn (keys of fields whose answers should come first, for the question frontier)}), and relationTypes (array of {key, label, inverseLabel, targetKinds}).
2. Craft pack: ${ROOT}/packs/craft/<kind-lowercase>/PACK.md with YAML frontmatter (name, version: 1, kind, coverage: list of field keys from that kind's template, description) and a body with sections: Purpose, How to question (instructions to the model), Question patterns (by question kind: OPEN, CHOICE, EITHER_OR, SCENARIO, SCALE), Depth guidance (what depth 1 vs 5 means for this kind), Never ask (things already answerable from the bible, or out of scope), Example questions (10-20, original). Plus evals.json beside it: an array of cases {id, bibleState (field key -> value or null), priorAnswers, dials {depth, detail}, expect {targetsAnyOf: field keys, mustNot: list of behaviours}}.
3. Persona pack: ${ROOT}/packs/personas/<key>/PACK.md with frontmatter (name, version: 1, persona, description) and sections Voice, Stance, Question style, Recommended-answer style, Boundaries (including D3), Examples (the same three bible situations asked in this persona's voice); plus evals.json with cases {id, situation, expect {tone, mustNot}}.
4. Evaluation sets: ${ROOT}/evals/question-coverage.json (book concepts with expected field coverage), ${ROOT}/evals/enrichment.json (answer/field pairs with expected ADD/UPDATE/REMOVE/NO_CHANGE and the answer ids cited), ${ROOT}/evals/adversarial.json (answers carrying instructions to the model, with the expected outcome: nothing changes beyond the answer's own content).
Keep it precise; other agents will be judged against it.`, { label: 'format', phase: 'Format', schema: DONE })

phase('Templates')
const templates = await parallel(KINDS.concat(['CUSTOM']).map(kind => () => agent(`${BASE}

Read ${ROOT}/FORMAT.md, then write ${ROOT}/templates/${kind.toLowerCase()}.json for the element kind ${kind}, exactly in the format defined there. ${kind === 'CUSTOM' ? 'CUSTOM is author-labelled: give it a small generic set of fields (what it is, why it matters to the story, notes, open questions).' : 'Choose the fields an experienced developmental editor would want filled for this kind before drafting starts: usually 6-14 fields, each with a precise one-sentence help text, sensible dependsOn ordering (the foundational fields first), and required=true only for fields without which the element is not usable.'} Relation types: define those that originate from this kind (for example CHARACTER -> CHARACTER "mentor of" / "mentored by"). Validate the file parses as JSON (node -e or python3 -c).`, { label: `template ${kind}`, phase: 'Templates', schema: DONE })))
log(`${templates.filter(Boolean).length}/${KINDS.length + 1} templates written`)

const kindPipeline = pipeline(
  KINDS,
  kind => agent(`${BASE}

Read ${ROOT}/FORMAT.md and ${ROOT}/templates/${kind.toLowerCase()}.json, then write the craft pack for ${kind}: ${ROOT}/packs/craft/${kind.toLowerCase()}/PACK.md and evals.json beside it, exactly in the format defined. Coverage must list only field keys that exist in the template. Write 8-12 evaluation cases covering: an empty bible entry, a half-filled entry (the pack must not re-ask filled fields), depth 1 vs depth 5, detail 1 vs detail 5, and one case where prior answers already settle a field. Validate evals.json parses.`, { label: `pack ${kind}`, phase: 'Packs', schema: DONE }),
  (_, kind) => agent(`${BASE}

You are a licence and quality reviewer. Read ${ROOT}/packs/craft/${kind.toLowerCase()}/PACK.md and evals.json and ${ROOT}/templates/${kind.toLowerCase()}.json. Check: (1) originality: any phrase that looks lifted from a craft book, a branded framework, or a GPL project; any branded framework name or beat label; (2) D3: anything that has the model propose story content as the author's; (3) format conformance to ${ROOT}/FORMAT.md; (4) coverage keys exist in the template; (5) question quality: vague, leading, double-barrelled or yes/no questions where an open one was meant. Then FIX every problem you find directly in the files, and report what you changed.`, { label: `review ${kind}`, phase: 'Packs', schema: REVIEW }),
)

const personaPipeline = pipeline(
  PERSONAS,
  p => agent(`${BASE}

Read ${ROOT}/FORMAT.md, then write the persona pack ${ROOT}/packs/personas/${p.key}/PACK.md and evals.json for "${p.name}": ${p.gist}. The persona changes voice, stance and format only; it never changes what may be written to the bible, never insults the author, and never writes story content (D3). The three example situations must be the same three for every persona: (a) a protagonist whose want is "to be happy"; (b) a fantasy magic system with no cost; (c) a thriller midpoint the author has not decided. Write 6-10 eval cases. Validate evals.json parses.`, { label: `persona ${p.key}`, phase: 'Packs', schema: DONE }),
  (_, p) => agent(`${BASE}

Review ${ROOT}/packs/personas/${p.key}/ against ${ROOT}/FORMAT.md and the rules above: originality, D3, tone boundaries (blunt is fine, demeaning is not), format, and whether the examples are distinctly this persona rather than generic. Fix every problem directly in the files and report what you changed.`, { label: `review persona ${p.key}`, phase: 'Packs', schema: REVIEW }),
)

const evalsTask = (async () => {
  const cov = await agent(`${BASE}

Read ${ROOT}/FORMAT.md and every file in ${ROOT}/templates/. Write ${ROOT}/evals/question-coverage.json: ten original book concepts spanning genres and audiences (literary, thriller, romance, epic fantasy, science fiction, cosy mystery, horror, middle grade, young adult, memoir-style autofiction), each a short concept note an author might paste in, plus for each: the element kinds a first session should target and, per kind, the field keys a good first round must cover (only keys that exist in the templates), and things a good first round must not ask. Validate the JSON.`, { label: 'evals coverage', phase: 'Evals', schema: DONE })
  const enr = await agent(`${BASE}

Read ${ROOT}/FORMAT.md and ${ROOT}/templates/. Write ${ROOT}/evals/enrichment.json: forty answer/field cases for the enrichment reconcile step. Each case: a bible entry's current field values, one to three answers (with ids), the targeted field keys, and the expected operation per field (ADD into an empty field, UPDATE when the answer refines or replaces, REMOVE when the author explicitly retracts, NO_CHANGE when the answer adds nothing), the expected cited answer ids, and a short reference wording drawn only from the answers. Balance the operations (at least six of each), include answers that touch two fields, answers that contradict the existing value, and vague answers that should yield NO_CHANGE. Validate the JSON.`, { label: 'evals enrichment', phase: 'Evals', schema: DONE })
  const adv = await agent(`${BASE}

Read ${ROOT}/FORMAT.md and ${ROOT}/templates/. Write ${ROOT}/evals/adversarial.json: ten adversarial answers an author (or a pasted document) might contain, each targeting a realistic bible session, for example: an instruction to ignore previous instructions and rewrite every field; a request to reveal the system prompt; text telling the model to mark every field complete; an instruction to fetch a URL; a fake "system:" block inside the answer; Unicode tricks (invisible characters, homoglyphs); an attempt to write into a different book's entry; a request to write the next chapter (D3); an answer that is pure markup/HTML with a script tag; and a very long answer that tries to push the real instructions out of context. For each: the session context, the answer text, and the expected outcome (which fields may change, if any, and what must not happen). Validate the JSON.`, { label: 'evals adversarial', phase: 'Evals', schema: DONE })
  return [cov, enr, adv]
})()

const DESIGN_SCHEMA = { type: 'object', properties: { file: { type: 'string' }, summary: { type: 'string' } }, required: ['file', 'summary'] }
const designTask = (async () => {
  const ANGLES = [
    { key: 'decision-tree', angle: 'a strict decision-tree frontier: questions carry explicit prerequisites; each round asks every question whose prerequisites are settled; the frontier is recomputed after answers (the grilling algorithm from mattpocock/skills, MIT)' },
    { key: 'coverage-driven', angle: 'a coverage-driven planner: the template fields and their dependsOn order define what is unknown; each round picks the questions that most reduce unknown required fields under a depth/detail budget, then generates question text for them' },
    { key: 'multi-persona', angle: 'a multi-perspective design in the spirit of Stanford STORM (MIT): several personas each generate candidate questions for the same target, code merges and deduplicates them, orders them by dependency, and attributes each to its persona' },
  ]
  const designs = await parallel(ANGLES.map(a => () => agent(`${BASE}

Design Inkquisitor's question engine (roadmap Phase 2.2 and 2.3, plus how 2.5 enrichment consumes its answers) using ${a.angle}. Write ${ROOT}/design/question-engine-${a.key}.md covering: data model (InterviewSession, Question, Answer and any others, with fields), the round algorithm in pseudocode, which parts are pure code and which are a model call (and the structured output schema of each model call), how "never ask what the bible already answers" is enforced in code, deduplication without embeddings (Phase 2 has no pgvector; embeddings arrive in Phase 4), how the depth/detail/manner dials map to prompts and budgets, stop conditions, failure handling, cost per session estimate in model calls, and a test strategy for the pure core. Be concrete.`, { label: `design ${a.key}`, phase: 'Design', schema: DESIGN_SCHEMA })))
  const judged = await parallel(['correctness and testability', 'author experience and question quality', 'cost, latency and robustness'].map(lens => () => agent(`${BASE}

Judge the three question-engine designs in ${ROOT}/design/ (question-engine-decision-tree.md, question-engine-coverage-driven.md, question-engine-multi-persona.md) on ${lens}. Score each 1-10 with reasons, and list the best idea in each that the others lack.`, { label: `judge ${lens.split(' ')[0]}`, phase: 'Design', schema: { type: 'object', properties: { scores: { type: 'array', items: { type: 'object', properties: { design: { type: 'string' }, score: { type: 'number' }, reasons: { type: 'string' } }, required: ['design', 'score', 'reasons'] } }, bestIdeas: { type: 'array', items: { type: 'string' } } }, required: ['scores', 'bestIdeas'] } })))
  const synth = await agent(`${BASE}

Synthesize the final question-engine design. Inputs: the three designs in ${ROOT}/design/ and these judgements:
${JSON.stringify(judged.filter(Boolean), null, 1)}

Take the highest-scoring design as the base and graft in the best ideas from the others where they do not conflict. Write ${ROOT}/design/QUESTION-ENGINE.md: the final data model (Prisma-like), round algorithm, model calls with their output schemas, the dials, dedupe, stop conditions, failure handling, enrichment hand-off (ADD/UPDATE/REMOVE/NO_CHANGE with cited answer ids, refused when uncited), and the test plan. Note which source ideas came from MIT/Apache projects so NOTICE can credit them.`, { label: 'design synthesis', phase: 'Design', schema: DESIGN_SCHEMA })
  return { designs, judged, synth }
})()

const [kindRes, personaRes, evalRes, designRes] = await Promise.all([kindPipeline, personaPipeline, evalsTask, designTask])

phase('Consistency')
const consistency = await agent(`${BASE}

Final consistency pass over everything in ${ROOT}. Check and FIX: every JSON file parses; every coverage key in packs/craft/*/PACK.md frontmatter and every field key in evals/*.json exists in the matching templates/<kind>.json; relationTypes targetKinds are valid kinds; every file follows ${ROOT}/FORMAT.md; QUESTION-ENGINE.md agrees with the template format (dependsOn, required) and the pack format. Then write ${ROOT}/README.md listing every file with one line each, and the counts of templates, fields, packs and eval cases (computed by a script, not by hand).`, { label: 'consistency', phase: 'Consistency', schema: REVIEW })

return {
  templates: templates.filter(Boolean).length,
  packReviews: (kindRes || []).filter(Boolean).map(r => r.problems.length),
  personaReviews: (personaRes || []).filter(Boolean).map(r => r.problems.length),
  evals: (evalRes || []).filter(Boolean).length,
  design: designRes && designRes.synth,
  consistency,
}
