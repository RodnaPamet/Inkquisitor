# Inkquisitor staged content (Phases 1 and 2)

The bible templates, interviewer packs, evaluation sets and question-engine
design for roadmap subphases 1.1, 2.2, 2.3 and 2.5. Every file follows
`FORMAT.md`. Nothing here is wired into the application yet: Phase 1.1 moves the
templates into the repository and validates them with Zod, and Phase 2.3 mounts
the packs once each has a passing evaluation record from a real model run
(none exists yet, and none is ever written by hand).

## Counts

Computed by a script over the files on 2026-11-19, not typed by hand; the
snippet at the end of this file recomputes the main figures.

| What | Count |
|---|---|
| Element kinds with a template | 15 |
| Template fields | 193 (71 core, 122 optional) |
| Relation types | 104 |
| Craft packs | 15 (217 example questions) |
| Persona packs | 6 |
| Craft evaluation cases | 176 |
| Persona evaluation cases | 57 |
| Question-coverage cases | 10 book concepts, 31 sessions |
| Enrichment cases | 27 cases, 55 answer/field operations (ADD 21, UPDATE 14, REMOVE 9, NO_CHANGE 11) |
| Adversarial cases | 14 cases over 11 attack categories |
| All evaluation cases | 284 |
| Packs in total | 21 |

## Files

| File | What it holds |
|---|---|
| `README.md` | This index and its computed counts |
| `FORMAT.md` | The binding file formats: vocabulary, templates, packs, evaluation sets, the PACK.md text-scan traps, the validation checklist, core fields, persona situations and banned framework vocabulary |
| `design/QUESTION-ENGINE.md` | Final design of the question engine (2.2, 2.3) and its enrichment hand-off (2.5): data model, round algorithm, model calls and schemas, dedupe without embeddings, dials, stops, failures, cost, test plan, credits |
| `templates/premise.json` | Premise field template: 12 fields (5 core, 7 optional), 7 relation types |
| `templates/plot.json` | Plot field template: 12 fields (6 core, 6 optional), 8 relation types |
| `templates/character.json` | Character field template: 14 fields (6 core, 8 optional), 8 relation types |
| `templates/setting.json` | Setting field template: 13 fields (4 core, 9 optional), 8 relation types |
| `templates/theme.json` | Theme field template: 12 fields (5 core, 7 optional), 7 relation types |
| `templates/mood.json` | Mood field template: 13 fields (4 core, 9 optional), 6 relation types |
| `templates/texture.json` | Texture field template: 13 fields (4 core, 9 optional), 7 relation types |
| `templates/style.json` | Prose style field template: 13 fields (5 core, 8 optional), 6 relation types |
| `templates/pov.json` | Point of view field template: 14 fields (5 core, 9 optional), 7 relation types |
| `templates/world_rule.json` | World rule field template: 14 fields (5 core, 9 optional), 8 relation types |
| `templates/timeline_event.json` | Timeline event field template: 13 fields (4 core, 9 optional), 8 relation types |
| `templates/faction.json` | Faction field template: 14 fields (5 core, 9 optional), 8 relation types |
| `templates/object.json` | Object field template: 13 fields (4 core, 9 optional), 6 relation types |
| `templates/research.json` | Research note field template: 14 fields (5 core, 9 optional), 4 relation types |
| `templates/custom.json` | Custom element field template: 9 fields (4 core, 5 optional), 6 relation types |
| `packs/craft/premise/PACK.md` | Premise craft pack: 12 coverage keys, 15 example questions, 7971 bytes |
| `packs/craft/premise/evals.json` | Premise craft evaluation set: 12 cases |
| `packs/craft/plot/PACK.md` | Plot craft pack: 12 coverage keys, 15 example questions, 8156 bytes |
| `packs/craft/plot/evals.json` | Plot craft evaluation set: 11 cases |
| `packs/craft/character/PACK.md` | Character craft pack: 13 coverage keys, 14 example questions, 8057 bytes |
| `packs/craft/character/evals.json` | Character craft evaluation set: 12 cases |
| `packs/craft/setting/PACK.md` | Setting craft pack: 13 coverage keys, 15 example questions, 8146 bytes |
| `packs/craft/setting/evals.json` | Setting craft evaluation set: 12 cases |
| `packs/craft/theme/PACK.md` | Theme craft pack: 12 coverage keys, 14 example questions, 8151 bytes |
| `packs/craft/theme/evals.json` | Theme craft evaluation set: 12 cases |
| `packs/craft/mood/PACK.md` | Mood craft pack: 12 coverage keys, 13 example questions, 8098 bytes |
| `packs/craft/mood/evals.json` | Mood craft evaluation set: 12 cases |
| `packs/craft/texture/PACK.md` | Texture craft pack: 13 coverage keys, 14 example questions, 8101 bytes |
| `packs/craft/texture/evals.json` | Texture craft evaluation set: 12 cases |
| `packs/craft/style/PACK.md` | Prose style craft pack: 13 coverage keys, 15 example questions, 7874 bytes |
| `packs/craft/style/evals.json` | Prose style craft evaluation set: 12 cases |
| `packs/craft/pov/PACK.md` | Point of view craft pack: 14 coverage keys, 16 example questions, 8091 bytes |
| `packs/craft/pov/evals.json` | Point of view craft evaluation set: 12 cases |
| `packs/craft/world_rule/PACK.md` | World rule craft pack: 14 coverage keys, 15 example questions, 8141 bytes |
| `packs/craft/world_rule/evals.json` | World rule craft evaluation set: 12 cases |
| `packs/craft/timeline_event/PACK.md` | Timeline event craft pack: 13 coverage keys, 14 example questions, 8083 bytes |
| `packs/craft/timeline_event/evals.json` | Timeline event craft evaluation set: 11 cases |
| `packs/craft/faction/PACK.md` | Faction craft pack: 14 coverage keys, 13 example questions, 7815 bytes |
| `packs/craft/faction/evals.json` | Faction craft evaluation set: 12 cases |
| `packs/craft/object/PACK.md` | Object craft pack: 13 coverage keys, 15 example questions, 8159 bytes |
| `packs/craft/object/evals.json` | Object craft evaluation set: 12 cases |
| `packs/craft/research/PACK.md` | Research note craft pack: 14 coverage keys, 15 example questions, 8147 bytes |
| `packs/craft/research/evals.json` | Research note craft evaluation set: 12 cases |
| `packs/craft/custom/PACK.md` | Custom element craft pack: 9 coverage keys, 14 example questions, 7951 bytes |
| `packs/craft/custom/evals.json` | Custom element craft evaluation set: 10 cases |
| `packs/personas/gentle-mentor/PACK.md` | Gentle Mentor persona pack: voice, stance, question and recommendation style, boundaries, S1 to S3 asked in this voice, 6038 bytes |
| `packs/personas/gentle-mentor/evals.json` | Gentle Mentor persona evaluation set: 9 cases (3 fixed situations, 6 inline) |
| `packs/personas/ruthless-editor/PACK.md` | Ruthless Editor persona pack: voice, stance, question and recommendation style, boundaries, S1 to S3 asked in this voice, 5773 bytes |
| `packs/personas/ruthless-editor/evals.json` | Ruthless Editor persona evaluation set: 10 cases (3 fixed situations, 7 inline) |
| `packs/personas/socratic/PACK.md` | Socratic persona pack: voice, stance, question and recommendation style, boundaries, S1 to S3 asked in this voice, 6021 bytes |
| `packs/personas/socratic/evals.json` | Socratic persona evaluation set: 10 cases (3 fixed situations, 7 inline) |
| `packs/personas/devils-advocate/PACK.md` | Devil's Advocate persona pack: voice, stance, question and recommendation style, boundaries, S1 to S3 asked in this voice, 6927 bytes |
| `packs/personas/devils-advocate/evals.json` | Devil's Advocate persona evaluation set: 10 cases (3 fixed situations, 7 inline) |
| `packs/personas/target-reader/PACK.md` | Target Reader persona pack: voice, stance, question and recommendation style, boundaries, S1 to S3 asked in this voice, 5949 bytes |
| `packs/personas/target-reader/evals.json` | Target Reader persona evaluation set: 9 cases (3 fixed situations, 6 inline) |
| `packs/personas/genre-specialist/PACK.md` | Genre Specialist persona pack: voice, stance, question and recommendation style, boundaries, S1 to S3 asked in this voice, 6041 bytes |
| `packs/personas/genre-specialist/evals.json` | Genre Specialist persona evaluation set: 9 cases (3 fixed situations, 6 inline) |
| `evals/question-coverage.json` | 10 invented book concepts, 31 sessions: which core fields a whole session must reach and must leave alone |
| `evals/enrichment.json` | 27 reconcile cases, 55 operations: expected ADD / UPDATE / REMOVE / NO_CHANGE per field, cited answer ids, required and forbidden phrases, and a reference wording drawn only from the answers |
| `evals/adversarial.json` | 14 answers carrying instructions to the model, with the outcome expected: only the answer's own story content changes anything |

## Changes made by the consistency pass (2026-11-19)

- Added `packs/craft/custom/` (PACK.md and evals.json): `FORMAT.md` requires
  one craft pack per kind, and the content workflow had skipped CUSTOM.
- Added the two missing persona packs, `target-reader` and `genre-specialist`,
  with the same S1 to S3 and the three shared inline situations the other four
  use (a want of "to be happy", a magic system with no cost, a thriller middle
  left undecided).
- `packs/craft/plot/PACK.md`, example 10: the scale anchors no longer contain
  a comma, which made the `Scale: 1 = <low>, 5 = <high>.` line ambiguous.
- `FORMAT.md` amended in three places: a `reference` key on each enrichment and
  adversarial operation (a reference wording drawn only from the answers, never
  compared verbatim); one adversarial answer of up to 6,000 characters for the
  long-answer override case; and this README and the design file listed in
  section 0.1.

## Recomputing the counts

```sh
python3 -c "
import json,glob
t=[json.load(open(f)) for f in glob.glob('templates/*.json')]
print('templates',len(t),'fields',sum(len(x['fields']) for x in t))
print('packs',len(glob.glob('packs/*/*/PACK.md')))
n=lambda p:sum(len(json.load(open(f))) for f in glob.glob(p))
print('craft cases',n('packs/craft/*/evals.json'),'persona cases',n('packs/personas/*/evals.json'))
for f in ('question-coverage','enrichment','adversarial'): print(f,len(json.load(open('evals/'+f+'.json'))))
"
```
