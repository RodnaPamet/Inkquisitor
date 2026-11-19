# Question engine: final design

*Written 2026-11-19 for roadmap subphases 2.2 (question engine) and 2.3 (dials
and packs), and for how 2.5 (enrichment) consumes the answers. Status: design,
nothing built.* The content this engine runs on is staged beside this file:
the field templates (`templates/`), the craft and persona packs (`packs/`),
and the evaluation sets (`evals/`, and each pack's `evals.json`), all in the
formats of `FORMAT.md`. Where this document and `FORMAT.md` describe the same
rule, they agree; if they ever differ, `FORMAT.md` decides the content and this
document is corrected.

## 1. Shape in one paragraph

The engine is a **pure core** with **three narrow model calls** around it.
Code decides *what* may be asked, in what order, how many questions a round
holds, whether a candidate question is acceptable, and whether a proposed
bible change is allowed. The model decides only *how a question is worded*
and *how answers are summarised into field values*. Each round, code computes
the **frontier**: every open field whose prerequisites are settled, after
removing everything the bible already holds (the grilling algorithm from
mattpocock/skills, MIT). Code assigns the frontier's fields to the session's
personas, each persona's model call words questions for its share (the
perspective idea from Stanford STORM, MIT), and code validates, deduplicates
and orders what comes back. When the author has answered, code recomputes
the frontier, and when the round closes a reconcile call proposes ADD,
UPDATE, REMOVE or NO_CHANGE per field, each citing the answers it is drawn
from (the mem0 reconciliation pattern, Apache-2.0). Code refuses any proposal
that cites nothing, cites outside the session, or reaches outside the round's
scope. Nothing reaches the bible until the author accepts it.

```
             ┌──────────────────────── pure core ────────────────────────┐
 bible ─────▶│ computeFrontier ─▶ planRound ─▶ buildPrompts               │
 answers ───▶│                                     │                      │
 dials ─────▶│                                     ▼                      │
 packs ─────▶│                         ┌── model: generateQuestions ──┐  │
             │                         │   (one call per persona)     │  │
             │                         └──────────────┬───────────────┘  │
             │ validateCandidates ◀─────────────────── ┘                  │
             │ dedupe ─▶ fillGapsFromPack ─▶ orderRound ─▶ present        │
             │                                                            │
             │ closeRound ─▶ ┌── model: reconcile ──┐ ─▶ validateProposals │
             │               └──────────────────────┘          │          │
             └─────────────────────────────────────────────────┼──────────┘
                                                               ▼
                                         author reviews: accept / edit / reject
                                                               ▼
                                         BibleEntryVersion (source INTERVIEW)
```

## 2. Vocabulary

- **Field reference** `(elementId, fieldKey)`: one field of one bible element.
  A session targeting one element uses that element's fields; a session on a
  whole kind or the whole book ("Grill me") uses the fields of every element
  in scope.
- **Level** of a field: 1 with no `dependsOn`, otherwise one more than the
  highest level among its `dependsOn` (FORMAT 1.4). Computed from the
  template at load time and cached.
- **Satisfied, touched, open, eligible**: exactly FORMAT 1.9, applied per
  field reference. A field is satisfied when the bible stores a value, when
  an `ANSWERED` answer in this session targeted it, or when a verified seed
  from the concept is pending for it (section 6). It is touched when any
  answer of any status in this session targeted it.
- **Frontier**: the eligible field references, ordered by kind order
  (FORMAT 1.1), then element creation order, then template `order`.
- **Challenge**: a question that quotes a stored value and asks the author to
  test or sharpen it (FORMAT 1.9). It never asks for the value afresh.

## 3. Data model

Prisma-like notation. Every table carries `workspaceId`, has row-level
security and is reached through `runInWorkspaceContext` (0.3). Columns marked
*enc* are in the field-encryption manifest: they hold author text or text
that quotes it, and they never reach a log line, a trace, an error report or
`AiCallLog` (rule 4).

```prisma
enum SessionScope   { ELEMENT KIND BOOK }
enum SessionStatus  { ACTIVE PAUSED COMPLETED STOPPED FAILED }
enum StopReason     { FRONTIER_EMPTY NOTHING_AT_DEPTH ROUND_BUDGET TOKEN_BUDGET
                      WORKSPACE_CEILING KILL_SWITCH AUTHOR_STOPPED PROVIDER_FAILURE }
enum QuestionKind   { OPEN CHOICE EITHER_OR SCENARIO SCALE }
enum QuestionMode   { FRONTIER CHALLENGE }
enum QuestionOrigin { MODEL PACK_FALLBACK REPHRASE }
enum AnswerStatus   { ANSWERED SKIPPED DECIDE_LATER }
enum ReconcileOp    { ADD UPDATE REMOVE NO_CHANGE }
enum ProposalStatus { PENDING ACCEPTED EDITED_ACCEPTED REJECTED REFUSED SUPERSEDED }

model InterviewSession {
  id               String        @id
  workspaceId      String
  bookId           String
  scope            SessionScope
  targetElementId  String?       // scope ELEMENT
  targetKind       ElementKind?  // scope KIND
  depth            Int           // 1..5
  detail           Int           // 1..5
  personaKeys      String[]      // 1..3, from the six persona keys
  offerRecommended Boolean       @default(true)
  preferChoice     Boolean       @default(false)  // "multiple choice where possible"
  status           SessionStatus @default(ACTIVE)
  stopReason       StopReason?
  stopDetail       Json?         // e.g. which fields wait on which deferred field
  roundBudget      Int           // from depth (section 8)
  roundsRun        Int           @default(0)
  tokenBudget      Int           // from depth x detail x personas (section 8)
  tokensUsed       Int           @default(0)
  costMicros       Int           @default(0)
  createdById      String
  createdAt        DateTime
  updatedAt        DateTime
  endedAt          DateTime?
}

model SessionPackPin {            // the content hash of every pack mounted, pinned at start (2.3)
  sessionId   String
  packName    String              // craft-character, persona-socratic, ...
  packVersion Int
  contentHash String
  evalRecordHash String           // the passing evaluation record it mounted with
  @@id([sessionId, packName])
}

model InterviewRound {
  id               String
  sessionId        String
  number           Int            // 1..roundBudget
  frontier         Json           // field references with their level, as computed
  assignments      Json           // field reference -> persona key
  promptVersion    String
  status           String         // GENERATING | OPEN | CLOSED | FAILED
  reconcileStatus  String         // NOT_RUN | RUNNING | DONE | FAILED
  startedAt        DateTime
  closedAt         DateTime?
  @@unique([sessionId, number])
}

model Question {
  id                   String
  sessionId            String
  roundId              String
  position             Int            // numbering within the round
  elementId            String
  targetsFieldKeys     String[]       // 1..2 keys of that element
  mode                 QuestionMode
  origin               QuestionOrigin
  personaKey           String?        // null for PACK_FALLBACK
  kind                 QuestionKind
  text                 String         // enc
  options              Json?          // enc; CHOICE 3..5, EITHER_OR exactly 2
  scaleLabels          Json?          // enc; SCALE only: { low, high }
  recommendedAnswer    Json?          // enc; option string, 1..5, or text
  recommendationBasis  Json?          // { fieldKeys: [], answerIds: [] }
  rationale            String?        // enc
  challengeQuote       String?        // enc; CHALLENGE only, verbatim from the stored value
  dependsOnQuestionIds String[]       // derived: questions whose answers satisfied the prerequisites
  dedupeKey            String         // normalised-text hash (section 7)
  shingles             Bytes          // MinHash signature (section 7)
  replacesQuestionId   String?        // "Ask me this differently"
  supersededAt         DateTime?
}

model Answer {
  id                     String
  questionId             String  @unique
  sessionId              String
  status                 AnswerStatus
  text                   String?  // enc; OPEN, SCENARIO, and the reason given with a pick
  choice                 String?  // enc; CHOICE, EITHER_OR
  scale                  Int?     // SCALE
  acceptedRecommendation Boolean  @default(false)
  guardVerdict           Json     // the 2.1 guard scanners' result (rule ids only, no text)
  answeredById           String
  answeredAt             DateTime
}

model ConceptSeed {               // a field value harvested from a concept note (section 6)
  id          String
  sessionId   String
  elementId   String              // the element whose field it would fill
  fieldKey    String
  sourceElementId String          // the RESEARCH element holding the concept (1.3)
  quote       String              // enc; verbatim substring of the concept text
  proposalId  String?
}

model EnrichmentProposal {
  id             String
  sessionId      String
  roundId        String?          // null for a concept seed proposal
  elementId      String
  fieldKey       String
  op             ReconcileOp      // NO_CHANGE is recorded for metrics, never shown
  proposedValue  Json?            // enc; typed by the field
  status         ProposalStatus
  refusalCode    String?          // CITES_NO_ANSWER, CITES_FOREIGN_ANSWER, ...
  decidedById    String?
  decidedAt      DateTime?
  versionId      String?          // the BibleEntryVersion an acceptance wrote
}

model ProposalCitation {          // exactly one of answerId / seedId
  proposalId String
  answerId   String?
  seedId     String?
}

model NewElementProposal {
  id               String
  sessionId        String
  kind             ElementKind
  name             String          // enc
  status           ProposalStatus
  createdElementId String?
  citedAnswerIds   String[]
}

model BookQuestionIndex {          // cross-session repetition (2.H); no text, only keys
  bookId      String
  elementId   String
  fieldKey    String
  dedupeKey   String
  shingles    Bytes
  questionId  String
  askedAt     DateTime
  @@index([bookId, elementId, fieldKey])
}
```

`AiCallLog` (2.1) records every call below with purpose
`QUESTION_GENERATION`, `REPHRASE`, `RECONCILE` or `CONCEPT_HARVEST`, the
prompt version, the pinned pack hashes, model, tokens, cost, duration and
outcome, and never any text.

A question's prerequisites are fields, not questions. The roadmap's
`dependsOn question ids` is kept as a derived column for display and audit:
for each target field, the questions whose `ANSWERED` answers satisfied that
field's `dependsOn` in this session. The frontier never reads it.

## 4. The pure core

Every function in this section is pure: no database, no clock, no network.
The usecase layer loads state, calls them, and persists what they return.

```ts
type FieldRef = { elementId: string; fieldKey: string };

computeFrontier(input: {
  elements: ElementState[];            // kind, template, stored values (null = empty)
  sessionAnswers: AnswerFact[];        // status + target field refs, this session only
  pendingSeeds: FieldRef[];            // verified concept seeds awaiting the author
  depth: number;
}): { frontier: FieldRef[]; blocked: BlockedField[] }
// blocked explains every open field not on the frontier:
// TOO_DEEP (level > depth), WAITS_ON (prerequisite open), WAITS_ON_DEFERRED
// (a prerequisite was skipped or deferred), TOUCHED (asked this session).

planRound(input: {
  frontier: FieldRef[];
  challengeable: FieldRef[];           // filled fields not yet challenged this session
  dials: Dials; personas: string[]; roundNumber: number; sessionId: string;
}): { targets: FieldRef[]; challenges: FieldRef[]; assignments: Map<FieldRef, string> }

validateCandidate(c: Candidate, ctx: ValidationContext): Verdict
dedupe(candidates: Candidate[], asked: AskedIndex): Candidate[]
fillGapsFromPack(targets: FieldRef[], accepted: Candidate[], packs: PackIndex, asked: AskedIndex): Candidate[]
orderRound(accepted: Candidate[]): Candidate[]
validateProposal(p: ProposalCandidate, ctx: ReconcileContext): ProposalVerdict
decideStop(state: SessionState): StopReason | null
```

### 4.1 The round, in pseudocode

```
startSession(book, scope, dials, personas):
    pin every pack the session will mount (craft pack per kind in scope, each persona)
    refuse to start if a pack has no passing evaluation record
    if scope holds empty fields and a concept note exists:
        seeds := conceptHarvest(...)              # model call 3, section 6
        store verified seeds as PENDING proposals
    runRound()

runRound():
    state  := load(session)                       # bible values, this session's answers, seeds
    reason := decideStop(state)                   # pure
    if reason: end(session, reason); return
    { frontier, blocked } := computeFrontier(state)          # pure
    if frontier is empty and no challenge is allowed:
        end(session, blocked shows only TOO_DEEP ? NOTHING_AT_DEPTH : FRONTIER_EMPTY,
            stopDetail := blocked)                # say which, and why
        return
    plan := planRound(frontier, challengeable(state), dials, personas)   # pure
    in parallel, for each persona p with assigned fields:
        out[p] := generateQuestions(promptFor(p, plan, state))  # model call 1
    candidates := flatten(out)
    accepted   := [c for c in candidates if validateCandidate(c, ctx).ok]   # pure
    accepted   := dedupe(accepted, askedInSessionAndBook)                   # pure
    accepted   += fillGapsFromPack(plan.targets, accepted, packs, asked)    # pure
    round      := orderRound(accepted)                                      # pure
    persist round, index each question in BookQuestionIndex
    stream questions to the author as each passes validation (2.4)

onAnswer(question, answer):                       # autosaved per answer
    persist answer (status, value, guard verdict)
    # the frontier is recomputed on the next runRound; answering does not
    # reveal new questions mid-round, so a round's numbering stays stable

closeRound():                                     # the author submits, or every question has a status
    round.status := CLOSED
    proposals := reconcile(round)                 # model call 2, section 9
    for p in proposals: store p with validateProposal(p, ctx)   # pure; refused ones kept as REFUSED
    session.roundsRun += 1
    runRound()
```

`decideStop` checks, in this order: the kill switch, the workspace spend
ceiling, the session token budget, an author stop, the round budget. The
frontier checks follow in `runRound` because they need the computed frontier.
Every stop is recorded with its reason, and the author sees it in one plain
sentence ("Every field this depth reaches is answered or set aside: the arc
waits on the need, which you chose to decide later.").

### 4.2 Round planning

- **Targets.** Every frontier field, in frontier order, up to the round's
  question cap (section 8). Fields beyond the cap stay on the frontier and
  lead the next round, so nothing is lost and the round budget decides how far
  the session gets.
- **Fields per question.** A question may target two fields only when both
  are on the frontier and the detail dial is 3 or more, where a reply of
  several sentences can serve both. Otherwise one.
- **Challenges.** Allowed when the frontier holds fewer fields than the cap
  and depth is 4 or 5, or when the frontier is empty and depth is 5. At most
  one challenge per round, two per session, and each filled field at most once
  per session. A challenge never displaces a frontier field. When the frontier
  is empty and no challenge is allowed, the session ends.
- **Persona assignment.** With one persona, it takes every target. With
  several, targets are dealt round-robin in frontier order, starting at the
  persona whose index is `(roundNumber - 1) mod personas`, so each persona
  leads in turn and the assignment is deterministic and testable. Each field is
  asked once per round, by exactly one persona, and every question carries its
  persona's name.

### 4.3 Candidate validation

A candidate passes only if every check holds. A failed check drops the
candidate, records the reason in the round's metrics, and leaves its field to
`fillGapsFromPack`. Checks map to the behaviour codes of FORMAT 1.11 where
code can decide them; the rest are left to the evaluation sets.

| Check | Code it enforces |
|---|---|
| `targetsFieldKeys` non-empty, all keys of the element's template, all assigned to this persona this round (FRONTIER), or one challengeable field (CHALLENGE) | `ASKS_ANSWERED_FIELD`, `SKIPS_DEPENDENCY`, `EXCEEDS_DEPTH`, `OUT_OF_SCOPE_KIND` |
| `kind` in the detail dial's allowed set (FORMAT 1.6) | `MISMATCHES_DETAIL` (kind part) |
| Options: CHOICE 3..5, EITHER_OR exactly 2, none on OPEN/SCENARIO, SCALE carries both anchors, no option matching the catch-all list ("other", "none of these", ...) | `MALFORMED_OPTIONS` |
| Text at most 280 characters before options, ends with `?`, contains exactly one `?` | `COMPOUND_QUESTION` (the cheap part) |
| CHALLENGE: `challengeQuote` is a verbatim substring of at least four words of the stored value, and the text contains it | a challenge is not `ASKS_ANSWERED_FIELD` |
| Recommendation, when present: CHOICE/EITHER_OR equals an option verbatim; SCALE is an integer 1..5; OPEN/SCENARIO passes the grounding test of 4.5 against the fields and answers in `recommendationBasis`; every key and id named there exists; toggle off means none | `UNGROUNDED_RECOMMENDATION` |
| Not a duplicate (section 7) | `REPEATS_PRIOR_QUESTION` |

A recommendation that fails is removed and the question kept: a weak
recommendation should not cost the author a good question.

### 4.4 Gap filling and ordering

When a target field has no accepted candidate, `fillGapsFromPack` takes the
first example question in the field's craft pack (FORMAT 3.3, the numbered
list) whose `(keys)` are exactly that field, whose kind the detail dial allows,
and which is not a duplicate. It is asked as written, with no recommendation
and `origin: PACK_FALLBACK`. If no example fits, the field is carried to the
next round and the round's metrics record `NO_QUESTION`. A round therefore
always asks something while its frontier is non-empty, unless every candidate
and every example has failed, which the metrics make visible.

`orderRound` sorts by frontier position of the first target, then puts
challenges last. Within the detail dial, a round may lead with picks and
scales before open questions (the Gentle Mentor's ordering); the persona pack
asks for this, and code keeps it stable by sorting kinds
`SCALE, EITHER_OR, CHOICE, OPEN, SCENARIO` within one element only when every
persona in the session asks for it.

### 4.5 The grounding test

Used for OPEN and SCENARIO recommendations and for every sentence of a
proposed bible value (section 9). Pure, no model:

1. Normalise both sides: Unicode NFKC, lower case, strip zero-width and
   other format characters, fold look-alike letters to ASCII where a mapping
   exists, collapse whitespace.
2. Tokenise into words; drop a short fixed stop-word list; reduce each word
   with a light suffix stripper (plural, `-ed`, `-ing`, `-ly`).
3. A sentence is **supported** when at least 70 % of its content tokens
   occur in the cited sources, and every capitalised token of the original
   (a likely name) occurs in them.

The threshold is a constant in one file, tuned against `evals/enrichment.json`
and `evals/adversarial.json`: every expected reference wording must pass, and
each `mustNotContain` embellishment added to it must fail.

## 5. Model calls and their structured output

Three calls, all through `callStructured(schema, prompt)` (2.1), all with
author text in fenced data blocks and never in the system prompt (rule 4).
The system prompt is the engine's fixed instructions plus the mounted packs;
the fenced data follows; a short restatement of the output rules closes the
prompt after the data, so a long answer cannot push the rules out of view
(`evals/adversarial.json`, adv-11). The fixed prefix (instructions and packs)
is identical across a session's calls and is marked for prompt caching.

### 5.1 `generateQuestions` (balanced tier; one call per persona per round)

Input, in order: engine instructions; the craft pack of each kind in play; the
persona pack; the dials and toggles in words (section 8); then fenced data: the
element's name and kind, its template fields with labels and help, the stored
values labelled *already answered, never ask afresh*, related elements'
summaries, this session's questions and answers, and finally the list of field
keys this persona may target this round and, if any, the one field it may
challenge.

Output schema:

```ts
const GeneratedQuestions = z.object({
  questions: z.array(z.object({
    targetsFieldKeys: z.array(z.string()).min(1).max(2),
    mode: z.enum(['FRONTIER', 'CHALLENGE']),
    kind: z.enum(['OPEN', 'CHOICE', 'EITHER_OR', 'SCENARIO', 'SCALE']),
    text: z.string().max(280),
    options: z.array(z.string().max(160)).min(2).max(5).optional(),
    scaleLabels: z.object({ low: z.string().max(40), high: z.string().max(40) }).optional(),
    challengeQuote: z.string().optional(),
    recommendedAnswer: z.union([z.string().max(600), z.number().int().min(1).max(5)]).optional(),
    recommendationBasis: z.object({
      fieldKeys: z.array(z.string()),
      answerIds: z.array(z.string()),
    }).optional(),
    rationale: z.string().max(400),
  })).max(12),
  declined: z.array(z.object({
    fieldKey: z.string(),
    reason: z.enum(['NOTHING_TO_ASK_WITHOUT_INVENTING', 'NEEDS_ANOTHER_ELEMENT_FIRST']),
  })),
}).strict();
```

`declined` lets the model say it cannot word a question without supplying
story content. Code treats a declined field like one with no candidate:
pack fallback, then carry-over. It never removes the field from the frontier.

### 5.2 `rephraseQuestion` (fast tier; "Ask me this differently", 2.4)

Input: the original question, its targets, its persona, the dials, and the
element context as in 5.1. Output: one item of the `questions` array above.
Code requires the same `targetsFieldKeys`, a kind the dial allows, and a
dedupe score below the paraphrase threshold against the original (section 7),
so the reworded question is genuinely different. The original is marked
superseded; only one of the pair can be answered.

### 5.3 `reconcile` (balanced tier; one call per closed round)

Input: engine reconcile instructions; then fenced data: the element's kind,
template field types, stored values for the **scope fields** (the fields this
round's questions targeted), the book's element list `{kind, name}`, and this
round's answers with ids and statuses. Earlier sessions' answers are not sent.

```ts
const ReconcileOutput = z.object({
  operations: z.array(z.object({
    fieldKey: z.string(),
    op: z.enum(['ADD', 'UPDATE', 'REMOVE', 'NO_CHANGE']),
    proposedValue: z.union([z.string(), z.array(z.string()), z.number().int(), z.null()]),
    cites: z.array(z.string()),
  })),
  newElements: z.array(z.object({
    kind: ElementKindEnum,
    name: z.string().max(120),
    cites: z.array(z.string()).min(1),
  })),
}).strict();
```

### 5.4 `conceptHarvest` (fast tier; once per session, only when needed)

Input: the scope's empty core fields with labels and help, and the fenced
concept note (the RESEARCH element of roadmap 1.3). Output:

```ts
const Harvest = z.object({
  seeds: z.array(z.object({
    elementId: z.string(), fieldKey: z.string(),
    quote: z.string().max(1200),   // must be copied from the note, unaltered
  })),
}).strict();
```

## 6. "Never ask what the bible already answers", in code

Five layers, each sufficient for a different failure:

1. **The frontier reads the bible first.** `computeFrontier` treats any
   stored value as satisfied before anything else is considered. A field with
   a value is never a target; it can only be a challenge, which must quote it.
2. **The session's own answers count before acceptance.** An `ANSWERED`
   answer satisfies its fields for the rest of the session, even while its
   proposal awaits review and even if the author later rejects it; a skipped
   or deferred field is touched and is not asked again in the session
   (FORMAT 1.9). A new session reopens fields that are still empty.
3. **What the concept states counts as stated.** At session start,
   `conceptHarvest` proposes values for empty fields that the concept note
   already states. Code keeps a seed only when its `quote` is a verbatim
   substring of the note (after the normalisation of 4.5 on both sides), and
   stores it as a pending proposal citing the seed. A field with a pending
   verified seed is satisfied for the session. If the author rejects the seed,
   the field reopens on the next round. This is how `statedInConcept` in
   `evals/question-coverage.json` is honoured without parsing the concept in
   Phase 1.
4. **The model is told and then checked.** The prompt lists the stored values
   as answered and names the only keys the persona may target; validation
   (4.3) drops any candidate targeting anything else.
5. **Repetition is caught after the fact.** Deduplication (section 7) runs
   against everything asked in the session and in the book.

## 7. Deduplication without embeddings

Phase 2 has no pgvector. Deduplication is lexical and runs in the pure core.

**Normalisation.** The text of 4.5 step 1, then: drop the element's own name
and role phrases ("your protagonist", "this place") so that two questions about
the same thing do not differ only in how they address it; drop stop words;
stem lightly. The sorted content tokens, joined, give `dedupeKey`
(SHA-256 of the string).

**Signals.** For a candidate `c` and an asked question `q`:

- `exact`: equal `dedupeKey`.
- `jaccard`: Jaccard similarity of content-token sets.
- `trigram`: Dice coefficient of character trigrams over the normalised text,
  approximated by a 64-value MinHash signature stored in `shingles`, so a
  book's index is compared without re-reading any text.
- `sameTarget`: `c` and `q` share a target field reference.
- `sameShape`: same kind and, for CHOICE and EITHER_OR, at least half the
  options equal after normalisation.

**Rule.** `c` duplicates `q` when `exact`, or when `sameTarget` and
(`jaccard ≥ 0.6` or `trigram ≥ 0.75` or `sameShape`), or when not
`sameTarget` and `jaccard ≥ 0.8`. The thresholds are constants in one file,
tuned on a fixture of paraphrase pairs (which must match) and near-miss pairs
on the same field (which must not), drawn from the packs' own example
questions.

**Scopes.**

- *Within a round*: candidates are compared with each other in frontier order;
  the first wins. With round-robin assignment this rarely fires.
- *Within the session*: against every question asked, answered or not.
- *Within the book* (2.H's repetition metric): against `BookQuestionIndex` for
  the same field reference. A field reopened in a new session may be asked
  again, but not in the same words, so a match here is a duplicate too.

**Repair.** A dropped duplicate goes to pack fallback, which is itself
deduplicated; a field whose every option is a duplicate is carried over and
recorded. The book-level metric (distinct questions over questions asked, per
field) is reported per session; it is a count over at least one question, and
reads "not assessed" for a session that asked none (rule 6).

## 8. Dials

A dial changes prompts and budgets only. It never changes which fields may be
written, which answers may be cited, or the validation rules (roadmap 2.3).

### 8.1 Depth (1..5)

| Depth | Fields in reach | Round budget | Prompt emphasis |
|---|---|---|---|
| 1 | level 1 only | 2 | foundations; no consequences or edge cases |
| 2 | level ≤ 2 | 3 | foundations and what directly rests on them |
| 3 | level ≤ 3 | 4 | consequences and pressures |
| 4 | level ≤ 4 | 5 | challenges allowed when the frontier is short |
| 5 | every field | 6 | consistency with related elements, edge cases, challenges |

Six rounds is the most any session runs, matching the simulation in FORMAT
5.1. The level of every core field is in FORMAT Appendix A; optional fields
take their level from their template `dependsOn`.

### 8.2 Detail (1..5)

| Detail | Kinds allowed (FORMAT 1.6) | Questions per round (cap) | Reply invited | Answer box limit | Generation `max_tokens` |
|---|---|---|---|---|---|
| 1 | CHOICE, EITHER_OR, SCALE | 8 | a pick or a number | none (pick) | 1,200 |
| 2 | + OPEN | 7 | one sentence | 300 chars | 1,400 |
| 3 | all five | 6 | up to three sentences | 600 chars | 1,600 |
| 4 | OPEN, SCENARIO, CHOICE, EITHER_OR | 4 | about a paragraph | 1,500 chars | 1,600 |
| 5 | OPEN, SCENARIO | 3 | several paragraphs | 4,000 chars | 1,400 |

The answer box limit is enforced by the UI and again by the usecase; text over
it is refused with a message, never silently cut. Each detail level has one
fixed sentence in the prompt describing the reply to invite, taken from the
table above.

### 8.3 Manner

- **Personas**: one to three of the six persona packs. Each mounted persona
  adds one generation call per round and its pack text to that call; it does
  not change the targets, which `planRound` deals out.
- **Offer a recommended answer** (default on): when off, the prompt asks for
  none and code strips any that arrive.
- **Multiple choice where possible**: when on and the detail dial allows
  CHOICE or EITHER_OR, the prompt asks for them first; code does not force a
  kind, because an open question that the dial allows is never wrong.

### 8.4 Budgets

The token budget of a session is
`roundBudget × personas × 9,000 + roundBudget × 6,000` tokens (input and
output together), a ceiling about a third to a half above the expected use in
section 10. A
round that would exceed it is not started (`TOKEN_BUDGET`). The workspace's
monthly spend ceiling (2.1) is checked before every call.

## 9. Enrichment hand-off (2.5)

When a round closes, `reconcile` runs over that round's answers. Its scope is
the fields the round's questions targeted, `scopeFieldKeys` in
`evals/enrichment.json`. For each proposal the model returns, `validateProposal`
applies these rules, in this order; the first failure refuses the proposal
with its code, and a refused proposal is kept (status `REFUSED`) for metrics
but never shown as a suggestion:

1. **One field, in scope.** `fieldKey` is a scope field of this element.
   Otherwise `TARGETS_OUT_OF_SCOPE_FIELD`. A volunteered detail about another
   field yields nothing; the author can open a session on that field.
2. **Operation allowed by the stored value.** ADD only into an empty field;
   UPDATE and REMOVE only on a filled one. NO_CHANGE always.
3. **Cites something.** ADD, UPDATE and REMOVE carry at least one citation:
   `CITES_NO_ANSWER` otherwise. This is the rule "a change that cites no
   answer is refused" (roadmap rule 2), applied before the value is read.
4. **Cites only this session's answered answers.** Every id is an answer of
   this session whose status is `ANSWERED`: `CITES_FOREIGN_ANSWER` for an id
   from another session or one that does not exist, `CITES_UNANSWERED` for a
   skipped or deferred one. A citation to a verified concept seed is accepted
   only on a seed proposal (section 6).
5. **Typed value.** The value has the field's type and bounds (FORMAT 1.3);
   REMOVE carries `null`.
6. **Every sentence sourced.** Each sentence of the proposed value passes the
   grounding test (4.5) against the cited answers plus, for UPDATE, the stored
   value. One unsupported sentence refuses the whole proposal:
   `UNSOURCED_SENTENCE`. Refused, not softened.
7. **No markup.** A value containing a tag, a script or a URL the cited
   answers present as an instruction is refused (`COPIES_INJECTED_TEXT`). Text
   the guard scanner flagged in a cited answer may still appear when it is
   story content (a spell, a creed: `IN_WORLD_TEXT`), and the review shows
   the guard's note beside it.

New-element proposals pass when their kind is valid, every citation passes
rule 4, the name occurs in a cited answer (normalised, case-insensitive), and
no element of the book already has that name or slug. They are offered to the
author as new elements, never created silently.

**Review.** The author sees one diff per field (`VersionDiff`): accept, edit
then accept, or reject. Bulk accept is offered only for ADD into empty fields.
Accepting writes one `BibleEntryVersion` with source `INTERVIEW` and links it
to the cited answers through `ProposalCitation`. Accepting a later proposal
for a field supersedes any earlier pending one for the same field.

**Whose answers count.** An answer satisfies its field for the frontier from
the moment it is given; the bible changes only on acceptance. So a rejected
proposal does not reopen a field within the session, and the next session sees
the field as empty again. This keeps the frontier mechanical (FORMAT 1.9) and
the bible author-decided (rule 1).

## 10. Stop conditions, failure handling and cost

### 10.1 Stop conditions

| Reason | When | What the author is told |
|---|---|---|
| `FRONTIER_EMPTY` | no eligible field and no challenge allowed | which fields are answered, and which wait on a deferred one |
| `NOTHING_AT_DEPTH` | the only open fields are too deep | raise depth to reach them, naming them |
| `ROUND_BUDGET` | the depth's round budget is spent | how many fields remain on the frontier |
| `TOKEN_BUDGET` / `WORKSPACE_CEILING` | the next round would exceed it | the session is kept and can resume later |
| `KILL_SWITCH` | the global switch is on | the session is kept |
| `AUTHOR_STOPPED` | the author stops | what was answered is kept and reconciled |
| `PROVIDER_FAILURE` | section 10.2 | the session is resumable |

A session with no questions asked reports "not assessed" in any coverage
figure, never 100 % (rule 6).

### 10.2 Failure handling

- **Timeout or provider error on generation**: one retry with backoff; then
  the round is generated from pack fallbacks alone if every target has one,
  else the session pauses (`PAUSED`, `PROVIDER_FAILURE`) with the round's
  frontier stored, and resumes from it.
- **Invalid structured output**: one repair attempt (2.1); if it fails
  again, the call's output is discarded and the round falls back as above.
  Candidates are validated one by one, so one bad item costs only itself.
- **Persona call fails, others succeed**: its fields go to pack fallback.
- **Reconcile fails**: answers are already saved; the round is marked
  `reconcileStatus: FAILED` and can be re-run. Nothing is proposed from a
  partial output.
- **Guard verdict on an answer**: the answer is stored and fenced as usual;
  the verdict travels with it to the review screen. Validation in section 9 is
  what stops an attack from changing anything; the guard is a second line.
- **Concurrency**: a round's close takes a per-session advisory lock, so two
  tabs cannot reconcile one round twice.

### 10.3 Cost per session

Expressed in tokens; the money figure is tokens times the per-token prices
of the configured tier (2.1's tier file), which change faster than this
document.

| Call | Input tokens | Output tokens |
|---|---|---|
| `generateQuestions`, per persona per round | 5,000 to 7,000 (two packs about 4,000, context 1,000 to 3,000) | 600 to 1,200 |
| `reconcile`, per round | 2,500 to 4,000 | 400 to 1,000 |
| `rephraseQuestion`, each | 3,500 | 200 |
| `conceptHarvest`, once | 1,500 to 3,000 | 300 to 800 |

A typical session (one element, depth 3, detail 3, one persona, four rounds)
uses about 4 × 6,000 + 4 × 3,200 ≈ 37,000 input and 4 × 900 + 4 × 700 ≈ 6,400
output tokens. Three personas raise generation to three calls a round, about
85,000 input tokens. Because the packs and instructions form an identical
prefix on every call in a session, prompt caching reads most of the input at
the cached rate after the first call. The worst case is bounded by the session
token budget (8.4).

## 11. Test plan for the pure core

All of these run in the unit project: no database, no network, no model.

1. **Frontier, from the staged fixtures.** For every case in every
   `packs/craft/*/evals.json`, `computeFrontier(bibleState, priorAnswers,
   depth)` equals `expect.targetsAnyOf`, in order. For S1 to S3 in FORMAT
   Appendix B, it yields `wound`, `stance` and `resolution`.
2. **Session simulation.** For every session in
   `evals/question-coverage.json`, a simulator that runs `computeFrontier`
   round after round, answering from `authorKnows` and deferring the rest,
   reproduces `mustCover` and `mustNotTarget` exactly.
3. **Frontier properties**, over generated templates (random acyclic
   `dependsOn`), random stored values and random answer histories: no
   frontier field has a stored value or was touched; every frontier field's
   prerequisites are satisfied; no frontier field is deeper than the dial;
   raising depth never removes a field; answering a frontier field never adds a
   field whose prerequisites it does not complete; a skipped field never
   returns in the session.
4. **Planning.** Assignment is deterministic, covers each target exactly
   once, rotates the lead persona by round, and respects the cap; challenges
   appear only under the depth rule and at most once per field.
5. **Candidate validation.** One fixture per row of the table in 4.3, each a
   candidate that breaks exactly that rule, must be dropped; the same
   candidate repaired must pass. Recommendations failing their rule are
   stripped and the question kept.
6. **Deduplication.** Paraphrase pairs drawn from pack example questions
   match; near-miss pairs on the same field do not; the book index catches a
   reworded repeat from an earlier session; a rephrase that is too close to its
   original is refused.
7. **Gap filling.** A target with no accepted candidate gets the first
   eligible pack example; an example of a disallowed kind or a duplicate is
   skipped; with none left the field is carried over and recorded.
8. **Proposal validation, from the staged fixtures.** Every expected operation
   in `evals/enrichment.json` and `evals/adversarial.json`, with its
   `reference` as the proposed value, passes `validateProposal`. Mutations of
   each must be refused with the matching code: drop the citations
   (`CITES_NO_ANSWER`), cite another session's answer (`CITES_FOREIGN_ANSWER`),
   cite a skipped one (`CITES_UNANSWERED`), move the field out of scope
   (`TARGETS_OUT_OF_SCOPE_FIELD`), append a sentence from `mustNotContain`
   (`UNSOURCED_SENTENCE`), ADD into a filled field, REMOVE an empty one.
9. **Grounding test.** Normalisation folds zero-width characters and the
   Cyrillic look-alikes used in `evals/adversarial.json`; a sentence built
   only from cited words passes; an added name fails.
10. **Stop decisions.** Each reason in 10.1 is produced by the minimal state
    that should produce it, and the checks run in the stated order.

What the pure core cannot judge (tone, leading wording, invented content in a
question, prose) is graded by the evaluation sets through the 2.3 harness, and
a pack mounts only with a passing record.

## 12. Sources of ideas, for NOTICE

No code or text is copied from any of these; the ideas are re-implemented.

| Project | Licence | Idea taken |
|---|---|---|
| mattpocock/skills (the grilling skill) | MIT | The interview as a decision tree; ask the whole frontier of questions whose prerequisites are settled; remove what the document already answers before asking; offer a recommended answer with each question; recompute after answers |
| stanford-oval/storm | MIT | Perspective-guided questioning: several interviewer personas, each contributing its own line of questions, tagged with its name |
| mem0ai/mem0 | Apache-2.0 | Reconciling new information into a stored entry as ADD, UPDATE, DELETE or NOOP (here ADD, UPDATE, REMOVE, NO_CHANGE), each tied to its source |
| danjdewhurst/story-skills | MIT | A bible of one entry per entity with typed fields and open questions, which the templates' shape follows |
| surveyjs/survey-library | MIT | Declaring when a question becomes visible from earlier answers (`visibleIf`), which the templates' `dependsOn` mirrors in a simpler form |

getzep/graphiti (Apache-2.0), named in the roadmap, is not used here: its
temporal fact invalidation belongs to Phase 4. The inspiration-only projects
of roadmap 1.2 contributed nothing to this design.
