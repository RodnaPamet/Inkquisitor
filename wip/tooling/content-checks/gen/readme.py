import json, os, re, sys, glob
from collections import Counter
ROOT = sys.argv[1]
KINDS = ["premise","plot","character","setting","theme","mood","texture","style","pov","world_rule","timeline_event","faction","object","research","custom"]
PERSONAS = ["gentle-mentor","ruthless-editor","socratic","devils-advocate","target-reader","genre-specialist"]
def J(p): return json.load(open(os.path.join(ROOT, p), encoding="utf-8"))
def T(p): return open(os.path.join(ROOT, p), encoding="utf-8").read()

lines = []; c = Counter()
tmpl_rows = []
for k in KINDS:
    t = J(f"templates/{k}.json")
    core = sum(1 for f in t["fields"] if f["required"]); n = len(t["fields"])
    c["templates"] += 1; c["fields"] += n; c["core"] += core; c["optional"] += n - core; c["relations"] += len(t["relationTypes"])
    tmpl_rows.append(f"| `templates/{k}.json` | {t['label']} field template: {n} fields ({core} core, {n-core} optional), {len(t['relationTypes'])} relation types |")
craft_rows = []
for k in KINDS:
    md = T(f"packs/craft/{k}/PACK.md")
    h1 = re.search(r"^# (.+)$", md, re.M).group(1)
    ex = len(re.findall(r"^\d+\. \[", md, re.M))
    cov = len(re.findall(r"^  - ", md.split("\n---\n")[0], re.M))
    ev = J(f"packs/craft/{k}/evals.json")
    c["craft_packs"] += 1; c["craft_examples"] += ex; c["craft_cases"] += len(ev)
    craft_rows.append(f"| `packs/craft/{k}/PACK.md` | {h1} craft pack: {cov} coverage keys, {ex} example questions, {len(md.encode())} bytes |")
    craft_rows.append(f"| `packs/craft/{k}/evals.json` | {h1} craft evaluation set: {len(ev)} cases |")
persona_rows = []
for p in PERSONAS:
    md = T(f"packs/personas/{p}/PACK.md")
    h1 = re.search(r"^# (.+)$", md, re.M).group(1)
    ev = J(f"packs/personas/{p}/evals.json")
    inline = sum(1 for e in ev if not isinstance(e["situation"], str))
    c["persona_packs"] += 1; c["persona_cases"] += len(ev)
    persona_rows.append(f"| `packs/personas/{p}/PACK.md` | {h1} persona pack: voice, stance, question and recommendation style, boundaries, S1 to S3 asked in this voice, {len(md.encode())} bytes |")
    persona_rows.append(f"| `packs/personas/{p}/evals.json` | {h1} persona evaluation set: {len(ev)} cases ({len(ev)-inline} fixed situations, {inline} inline) |")
qc = J("evals/question-coverage.json"); en = J("evals/enrichment.json"); ad = J("evals/adversarial.json")
sess = sum(len(x["sessions"]) for x in qc)
ops = Counter(o["op"] for x in en for o in x["expect"]["operations"])
nops = sum(ops.values())
attacks = Counter(x["attack"] for x in ad)
c["qc"] = len(qc); c["en"] = len(en); c["ad"] = len(ad)
total_cases = c["craft_cases"] + c["persona_cases"] + c["qc"] + c["en"] + c["ad"]

out = f"""# Inkquisitor staged content (Phases 1 and 2)

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
| Element kinds with a template | {c['templates']} |
| Template fields | {c['fields']} ({c['core']} core, {c['optional']} optional) |
| Relation types | {c['relations']} |
| Craft packs | {c['craft_packs']} ({c['craft_examples']} example questions) |
| Persona packs | {c['persona_packs']} |
| Craft evaluation cases | {c['craft_cases']} |
| Persona evaluation cases | {c['persona_cases']} |
| Question-coverage cases | {c['qc']} book concepts, {sess} sessions |
| Enrichment cases | {c['en']} cases, {nops} answer/field operations (ADD {ops['ADD']}, UPDATE {ops['UPDATE']}, REMOVE {ops['REMOVE']}, NO_CHANGE {ops['NO_CHANGE']}) |
| Adversarial cases | {c['ad']} cases over {len(attacks)} attack categories |
| All evaluation cases | {total_cases} |
| Packs in total | {c['craft_packs'] + c['persona_packs']} |

## Files

| File | What it holds |
|---|---|
| `README.md` | This index and its computed counts |
| `FORMAT.md` | The binding file formats: vocabulary, templates, packs, evaluation sets, the PACK.md text-scan traps, the validation checklist, core fields, persona situations and banned framework vocabulary |
| `design/QUESTION-ENGINE.md` | Final design of the question engine (2.2, 2.3) and its enrichment hand-off (2.5): data model, round algorithm, model calls and schemas, dedupe without embeddings, dials, stops, failures, cost, test plan, credits |
""" + "\n".join(tmpl_rows) + "\n" + "\n".join(craft_rows) + "\n" + "\n".join(persona_rows) + f"""
| `evals/question-coverage.json` | {len(qc)} invented book concepts, {sess} sessions: which core fields a whole session must reach and must leave alone |
| `evals/enrichment.json` | {len(en)} reconcile cases, {nops} operations: expected ADD / UPDATE / REMOVE / NO_CHANGE per field, cited answer ids, required and forbidden phrases, and a reference wording drawn only from the answers |
| `evals/adversarial.json` | {len(ad)} answers carrying instructions to the model, with the outcome expected: only the answer's own story content changes anything |

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
"""
open(os.path.join(ROOT, "README.md"), "w", encoding="utf-8").write(out)
print(out[:1800])
