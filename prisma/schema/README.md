# Prisma schema folder

Prisma reads every `.prisma` file in this folder (named in `prisma.config.ts`)
and concatenates them at generate and migrate time.

| File | Holds |
|---|---|
| `base.prisma` | The `generator` and `datasource` blocks — and nothing else. Prisma rejects a duplicate of either anywhere in the folder. |
| `enums.prisma` | Every shared enum (`WorkspaceRole`; the bible's `BibleElementKind`, `BibleElementStatus`, `BookStage`, `BibleVersionSource`; the question engine's `InterviewScope`, `InterviewStatus`, `InterviewStopReason`, `InterviewRoundStatus`, `QuestionKind`, `QuestionMode`, `QuestionOrigin`, `AnswerStatus`; the model layer's `AiCallOutcome`, `AiModelTier`; enrichment's `EnrichmentOperation`, `EnrichmentProposalKind`, `EnrichmentProposalStatus`, `ReconcileRunStatus`; research's `ResearchDepth`, `ResearchBriefStatus`, `ResearchRunStatus`, `ResearchConfidence`, `ResearchCitationKind`, `ResearchProposalOperation`; the canvas's `StoryMapKind`). |
| `auth.prisma` | People and how they sign in: `User`, `Account`, `VerificationToken`, `UserSession`. Not workspace-scoped. |
| `workspace.prisma` | `Workspace` (with its wrapped data key) and `WorkspaceMembership`. Workspace-scoped. |
| `audit.prisma` | `AuditLog`, the append-only, hash-chained trail. Workspace-scoped. |
| `bible.prisma` | The book bible (Phase 1.1): `Book`, `BibleElement`, `BibleField`, `BibleRelation`, `BibleEntryVersion` (append-only). Workspace-scoped; the workspace travels in every foreign key. |
| `ai.prisma` | The model layer's ledger (Phase 2.1): `AiCallLog` (one row per model call, numbers and names only, append-only), `AiSpendMonth` (settled spend per UTC month) and `AiSpendReservation` (a running call's worst case). Workspace-scoped; written only by `src/app-layer/repositories/ai-call.repository.ts`. |
| `interview.prisma` | The question engine (Phase 2.2): `InterviewSession`, `InterviewRound`, `Question`, `Answer` (append-only). Workspace-scoped; the workspace travels in every foreign key, and a question's element is reached by `(bookId, elementId)`. |
| `enrichment.prisma` | Enrichment (Phase 2.5): `ReconcileRun` (a closed round's reconcile step, counts only), `EnrichmentProposal` (a proposed field change or new element, its text encrypted; only its one decision ever changes it) and `EnrichmentCitation` (the answers a proposal is drawn from, by `(workspaceId, sessionId, answerId)`). Workspace-scoped. Nothing here writes the bible: an acceptance does, through the versioned save. |
| `research.prisma` | The research agent (Phase 2.6): `ResearchBrief` (a question, its purpose, scope and depth; text encrypted), `ResearchSource` (a file the author attached, as extracted text), `ResearchRun` (one background run, counts and codes only), `ResearchFinding` and `ResearchCitation` (a claim and the quoted spans it rests on), `ResearchProposal` and `ResearchProposalFinding` (a proposed bible change and the findings it cites). Workspace-scoped. Nothing here writes the bible: an acceptance does, through the versioned save with source RESEARCH. |
| `canvas.prisma` | The story canvas (Phase 3.1): `StoryMap` (one per book and kind, decision D18; the version lock and the encrypted freeform layer), `MapNode` (a BibleElement drawn), `MapEdge` (a BibleRelation drawn), `MapSnapshot` (one per save, encrypted, append-only). Workspace-scoped; the book travels in every foreign key. |
| `vector.prisma` | The vector store (subphase 2.0): `VectorEmbedding`, vectors only, one table for every embedding revision and source model. Workspace-scoped; the `embedding` column is `Unsupported("vector")` and reached only through `src/app-layer/repositories/vector.repository.ts`. |

Pick the file that matches a new model's
domain and keep files to about thirty models. A model with a `workspaceId` is
workspace-scoped and needs its row-level security in the same migration
(`docs/rls-workspace-isolation.md`); a model without one must be listed in
`GLOBAL_MODELS` (`src/lib/db/rls-tripwire.ts`). Both coverage tests enforce
it.
