# Prisma schema folder

Prisma reads every `.prisma` file in this folder (named in `prisma.config.ts`)
and concatenates them at generate and migrate time.

| File | Holds |
|---|---|
| `base.prisma` | The `generator` and `datasource` blocks — and nothing else. Prisma rejects a duplicate of either anywhere in the folder. |
| `enums.prisma` | Every shared enum (`WorkspaceRole`; the bible's `BibleElementKind`, `BibleElementStatus`, `BookStage`, `BibleVersionSource`; the question engine's `InterviewScope`, `InterviewStatus`, `InterviewStopReason`, `InterviewRoundStatus`, `QuestionKind`, `QuestionMode`, `QuestionOrigin`, `AnswerStatus`). |
| `auth.prisma` | People and how they sign in: `User`, `Account`, `VerificationToken`, `UserSession`. Not workspace-scoped. |
| `workspace.prisma` | `Workspace` (with its wrapped data key) and `WorkspaceMembership`. Workspace-scoped. |
| `audit.prisma` | `AuditLog`, the append-only, hash-chained trail. Workspace-scoped. |
| `bible.prisma` | The book bible (Phase 1.1): `Book`, `BibleElement`, `BibleField`, `BibleRelation`, `BibleEntryVersion` (append-only). Workspace-scoped; the workspace travels in every foreign key. |
| `interview.prisma` | The question engine (Phase 2.2): `InterviewSession`, `InterviewRound`, `Question`, `Answer` (append-only). Workspace-scoped; the workspace travels in every foreign key, and a question's element is reached by `(bookId, elementId)`. |
| `vector.prisma` | The vector store (subphase 2.0): `VectorEmbedding`, vectors only, one table for every embedding revision and source model. Workspace-scoped; the `embedding` column is `Unsupported("vector")` and reached only through `src/app-layer/repositories/vector.repository.ts`. |

Pick the file that matches a new model's
domain and keep files to about thirty models. A model with a `workspaceId` is
workspace-scoped and needs its row-level security in the same migration
(`docs/rls-workspace-isolation.md`); a model without one must be listed in
`GLOBAL_MODELS` (`src/lib/db/rls-tripwire.ts`). Both coverage tests enforce
it.
